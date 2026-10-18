/**
 * Persistence port for the agent. The orchestrator depends only on this interface, so its
 * behaviour (lifecycle, confirmation binding, cancellation, idempotency) is unit-tested with the
 * in-memory implementation; production uses the Prisma implementation.
 */

import type { ToolCall } from './providers/types.js';

export const TASK_STATUS = {
  RECEIVED: 'RECEIVED',
  ANALYZING: 'ANALYZING',
  AWAITING_CLARIFICATION: 'AWAITING_CLARIFICATION',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  COMPLETED: 'COMPLETED',
  PARTIALLY_COMPLETED: 'PARTIALLY_COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TASK_STATUS.AWAITING_CLARIFICATION,
  TASK_STATUS.COMPLETED,
  TASK_STATUS.PARTIALLY_COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
]);

export interface ConversationRecord {
  id: string;
  userId: string;
  title: string;
  locale: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls: ToolCall[] | null;
  toolCallId: string | null;
  taskId: string | null;
  createdAt: Date;
}

export interface TaskRecord {
  id: string;
  conversationId: string;
  userId: string;
  status: TaskStatus;
  plan: string | null;
  stepCount: number;
  toolCallCount: number;
  provider: string | null;
  model: string | null;
  error: string | null;
  /** Set while AWAITING_CONFIRMATION. */
  pending: { confirmationId: string; toolCallId: string } | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export type ExecutionStatus = 'SUCCEEDED' | 'FAILED' | 'REJECTED' | 'PENDING_CONFIRMATION' | 'SKIPPED';

export interface ExecutionRecord {
  id: string;
  taskId: string;
  userId: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
  status: ExecutionStatus;
  summary: string | null;
  verification: string | null;
  userOutput: Record<string, unknown> | null;
  errorCode: string | null;
  confirmationId: string | null;
  latencyMs: number | null;
  createdAt: Date;
}

export interface ConfirmationRecord {
  id: string;
  userId: string;
  taskId: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
  argsHash: string;
  summary: string;
  preview: unknown;
  risk: 'low' | 'medium' | 'high';
  status: 'PENDING' | 'CONSUMED' | 'REJECTED' | 'EXPIRED';
  expiresAt: Date;
  decidedAt: Date | null;
  createdAt: Date;
}

export interface AgentStore {
  createConversation(userId: string, locale: string, title: string): Promise<ConversationRecord>;
  getConversation(userId: string, id: string): Promise<ConversationRecord | null>;
  listConversations(userId: string, limit: number): Promise<ConversationRecord[]>;
  deleteConversation(userId: string, id: string): Promise<boolean>;
  updateConversation(id: string, patch: { title?: string; locale?: string }): Promise<void>;

  appendMessage(
    conversationId: string,
    data: { role: MessageRecord['role']; content: string; toolCalls?: ToolCall[] | null; toolCallId?: string | null; taskId?: string | null },
  ): Promise<MessageRecord>;
  listMessages(conversationId: string, limit: number): Promise<MessageRecord[]>;

  createTask(data: { conversationId: string; userId: string; provider: string | null; model: string | null }): Promise<TaskRecord>;
  getTask(id: string): Promise<TaskRecord | null>;
  getTaskForUser(userId: string, id: string): Promise<TaskRecord | null>;
  updateTask(id: string, patch: Partial<Omit<TaskRecord, 'id' | 'conversationId' | 'userId' | 'createdAt' | 'updatedAt'>>): Promise<TaskRecord>;
  /** Atomic status transition; `false` if the task was not in `from` (e.g. cancelled meanwhile). */
  transitionTask(id: string, from: TaskStatus[], to: TaskStatus, patch?: Partial<Pick<TaskRecord, 'pending' | 'error' | 'finishedAt'>>): Promise<boolean>;
  activeTaskForConversation(conversationId: string): Promise<TaskRecord | null>;
  listTasks(conversationId: string, limit: number): Promise<TaskRecord[]>;
  failOrphans(olderThan: Date): Promise<number>;

  findExecution(taskId: string, toolCallId: string): Promise<ExecutionRecord | null>;
  saveExecution(data: Omit<ExecutionRecord, 'id' | 'createdAt'>): Promise<ExecutionRecord>;
  listExecutions(taskId: string): Promise<ExecutionRecord[]>;

  createConfirmation(data: Omit<ConfirmationRecord, 'id' | 'status' | 'decidedAt' | 'createdAt'>): Promise<ConfirmationRecord>;
  getConfirmationForUser(userId: string, id: string): Promise<ConfirmationRecord | null>;
  /** Atomic: PENDING and not expired → CONSUMED. Returns the record, or `null` (expired/used/other user). */
  consumeConfirmation(id: string, userId: string, now: Date): Promise<ConfirmationRecord | null>;
  /** Atomic: PENDING → REJECTED or EXPIRED. */
  closeConfirmation(id: string, userId: string, status: 'REJECTED' | 'EXPIRED', now: Date): Promise<boolean>;

  recordUsage(data: { userId: string; taskId: string | null; provider: string; model: string; inputTokens: number; outputTokens: number }): Promise<void>;
  tokensSince(userId: string, since: Date): Promise<number>;
}
