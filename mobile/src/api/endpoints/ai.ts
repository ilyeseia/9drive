/**
 * Client for the EXISTING 9Drive AI orchestrator (backend/src/modules/ai, documented in docs/ai-assistant.md).
 * The mobile app implements no agent of its own: the server owns the model, the allow-listed tools, the risk policy
 * and the hash-bound, single-use confirmations. This module only sends text and shows what the server reports.
 *
 * Nothing the model or a tool returns is trusted as markup or as an instruction: it is rendered as plain text /
 * restricted Markdown by the UI and never executed.
 */

import { z } from 'zod';
import type { ApiClient } from '../client';
import { ApiError } from '../errors';
import { isoDate } from '../schemas';

export const TASK_STATUSES = [
  'RECEIVED',
  'ANALYZING',
  'AWAITING_CLARIFICATION',
  'AWAITING_CONFIRMATION',
  'EXECUTING',
  'VERIFYING',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const statusSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  tools: z.number(),
});
export type AssistantStatus = z.infer<typeof statusSchema>;

export const conversationSchema = z.object({ id: z.string(), title: z.string(), locale: z.string(), updatedAt: isoDate });
export type ConversationSummary = z.infer<typeof conversationSchema>;

export const messageSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  taskId: z.string().nullable(),
  createdAt: isoDate,
});
export type ChatMessage = z.infer<typeof messageSchema>;

export const taskSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  status: z.enum(TASK_STATUSES),
  stepCount: z.number(),
  toolCallCount: z.number(),
  error: z.string().nullable(),
});
export type TaskDto = z.infer<typeof taskSchema>;

export const stepSchema = z.object({
  id: z.string(),
  tool: z.string(),
  status: z.enum(['SUCCEEDED', 'FAILED', 'REJECTED', 'PENDING_CONFIRMATION', 'SKIPPED']),
  summary: z.string().nullable(),
  verification: z.string().nullable(),
  errorCode: z.string().nullable(),
});
export type StepDto = z.infer<typeof stepSchema>;

export const confirmationSchema = z.object({
  id: z.string(),
  status: z.string(),
  tool: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  summary: z.string(),
  preview: z
    .object({ affectedCount: z.number().optional(), sample: z.array(z.string()).optional(), warnings: z.array(z.string()).optional() })
    .nullable(),
  argsHash: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: isoDate,
});
export type ConfirmationDto = z.infer<typeof confirmationSchema>;

export const taskViewSchema = z.object({
  task: taskSchema,
  steps: z.array(stepSchema),
  confirmation: confirmationSchema.nullable(),
  messages: z.array(messageSchema),
});
export type TaskView = z.infer<typeof taskViewSchema>;

const conversationDetailSchema = z.object({
  conversation: z.object({ id: z.string(), title: z.string(), locale: z.string() }),
  messages: z.array(messageSchema),
  activeTaskId: z.string().nullable(),
});

export const aiApi = {
  status: (client: ApiClient, signal?: AbortSignal) => client.request({ path: '/ai/status', schema: statusSchema.passthrough(), signal }),
  conversations: (client: ApiClient, signal?: AbortSignal) =>
    client
      .request({ path: '/ai/conversations', schema: z.object({ conversations: z.array(conversationSchema) }), signal })
      .then((r) => r.conversations),
  createConversation: (client: ApiClient, locale: string) =>
    client
      .request({ method: 'POST', path: '/ai/conversations', body: { locale }, schema: z.object({ conversation: conversationSchema }) })
      .then((r) => r.conversation),
  conversation: (client: ApiClient, id: string, signal?: AbortSignal) =>
    client.request({ path: `/ai/conversations/${encodeURIComponent(id)}`, schema: conversationDetailSchema, signal }),
  deleteConversation: (client: ApiClient, id: string) =>
    client.requestVoid({ method: 'DELETE', path: `/ai/conversations/${encodeURIComponent(id)}` }),
  // Not idempotent: a duplicate would run the request twice. The user retries explicitly.
  send: (client: ApiClient, conversationId: string, text: string, locale: string) =>
    client
      .request({
        method: 'POST',
        path: `/ai/conversations/${encodeURIComponent(conversationId)}/messages`,
        body: { text, locale },
        schema: z.object({ task: taskSchema }),
      })
      .then((r) => r.task),
  task: (client: ApiClient, taskId: string, afterSeq: number, signal?: AbortSignal) =>
    client.request({ path: `/ai/tasks/${encodeURIComponent(taskId)}`, query: { afterSeq }, schema: taskViewSchema, signal }),
  cancel: (client: ApiClient, taskId: string) =>
    client
      .request({ method: 'POST', path: `/ai/tasks/${encodeURIComponent(taskId)}/cancel`, body: {}, schema: z.object({ task: taskSchema }) })
      .then((r) => r.task),
  /** The hash binds the approval to the exact action that was shown; the server rejects anything that changed. */
  approve: (client: ApiClient, confirmationId: string, argsHash: string) =>
    client
      .request({
        method: 'POST',
        path: `/ai/confirmations/${encodeURIComponent(confirmationId)}/approve`,
        body: { argsHash },
        schema: z.object({ task: taskSchema }),
      })
      .then((r) => r.task),
  reject: (client: ApiClient, confirmationId: string) =>
    client
      .request({
        method: 'POST',
        path: `/ai/confirmations/${encodeURIComponent(confirmationId)}/reject`,
        body: {},
        schema: z.object({ task: taskSchema }),
      })
      .then((r) => r.task),
};

const FINISHED: ReadonlySet<TaskStatus> = new Set(['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED', 'AWAITING_CLARIFICATION']);
const BUSY: ReadonlySet<TaskStatus> = new Set(['RECEIVED', 'ANALYZING', 'EXECUTING', 'VERIFYING']);

export const isFinished = (status: TaskStatus): boolean => FINISHED.has(status);
export const isBusy = (status: TaskStatus): boolean => BUSY.has(status);

export type AiErrorKey = 'errAiBusy' | 'errAiNotConfigured' | 'errAiLimit' | 'errAiMismatch' | 'errAiConfirmationUsed' | 'errAiRateLimited';

/** Server AI error codes with a more specific message than the generic one for their kind. */
export function aiErrorKey(error: unknown): AiErrorKey | null {
  if (!ApiError.is(error)) return null;
  switch (error.code) {
    case 'TASK_IN_PROGRESS':
      return 'errAiBusy';
    case 'AI_NOT_CONFIGURED':
      return 'errAiNotConfigured';
    case 'USAGE_LIMIT_REACHED':
      return 'errAiLimit';
    case 'CONFIRMATION_MISMATCH':
      return 'errAiMismatch';
    case 'CONFIRMATION_USED':
    case 'CONFIRMATION_EXPIRED':
    case 'CONFIRMATION_INVALID':
      return 'errAiConfirmationUsed';
    case 'TOO_MANY_TASKS':
    case 'SERVER_BUSY':
      return 'errAiRateLimited';
    default:
      return null;
  }
}

/** `mm:ss` until `expiresAt`, or null once it has passed. */
export function remainingTime(expiresAt: string, now: number): string | null {
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.ceil(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Merge polled messages into the transcript by sequence number (idempotent). */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const bySeq = new Map(current.map((m) => [m.seq, m]));
  for (const message of incoming) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Tool names are for display only: lower-case words, no markup. */
export function humanizeTool(name: string): string {
  return name.replace(/[^a-z0-9_]/gi, '').replace(/_/g, ' ');
}
