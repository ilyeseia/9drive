/**
 * AI assistant API (mounted at /ai). Every route is authenticated and user-scoped; the model never
 * sees or controls the user id. Long work runs as a persisted task that the client polls.
 */

import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js';
import { aiMessageLimiter, aiReadLimiter, aiToolRunLimiter } from '../../middleware/rate-limit.middleware.js';
import { createAuditLog } from '../../utils/audit.js';
import { AgentError } from './agent.js';
import { getAiConfig, publicAiStatus } from './config.js';
import { requiresConfirmation } from './policy.js';
import { cleanText, toModelJson } from './sanitize.js';
import { getAgent, getAgentStore, getToolRegistry } from './runtime.js';
import { parseToolArgs, runTool } from './tools/registry.js';
import type { ConfirmationRecord, ExecutionRecord, MessageRecord, TaskRecord } from './store.js';

export const aiRouter = Router();
aiRouter.use(requireAuth);

const LOCALES = ['en', 'ar', 'fr'] as const;
const localeSchema = z.enum(LOCALES);
const MAX_BODY_BYTES = 16 * 1024;

function limitBody(req: Request, res: Response, next: NextFunction) {
  const length = Number(req.header('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' });
  return next();
}

function fail(res: Response, next: NextFunction, error: unknown) {
  if (error instanceof AgentError) return res.status(error.status).json({ code: error.code, message: error.message });
  return next(error);
}

const idParam = z.string().uuid();

function taskDto(task: TaskRecord) {
  return {
    id: task.id,
    conversationId: task.conversationId,
    status: task.status,
    stepCount: task.stepCount,
    toolCallCount: task.toolCallCount,
    error: task.error ? cleanText(task.error, 300) : null,
    createdAt: task.createdAt.toISOString(),
    finishedAt: task.finishedAt?.toISOString() ?? null,
  };
}

function stepDto(step: ExecutionRecord) {
  return {
    id: step.id,
    tool: step.toolName,
    status: step.status,
    summary: step.summary,
    verification: step.verification,
    errorCode: step.errorCode,
    latencyMs: step.latencyMs,
    // Shown only to the owner of the task (e.g. a share URL that the model never sees).
    userOutput: step.userOutput,
  };
}

function confirmationDto(confirmation: ConfirmationRecord) {
  return {
    id: confirmation.id,
    status: confirmation.status,
    tool: confirmation.toolName,
    risk: confirmation.risk,
    summary: confirmation.summary,
    preview: confirmation.preview,
    argsHash: confirmation.argsHash,
    expiresAt: confirmation.expiresAt.toISOString(),
  };
}

/** Transcript shown to the user: their text and the assistant's text — never raw tool payloads. */
function messageDto(message: MessageRecord) {
  return { id: message.id, seq: message.seq, role: message.role, content: message.content, taskId: message.taskId, createdAt: message.createdAt.toISOString() };
}

const visible = (message: MessageRecord) => (message.role === 'user' || (message.role === 'assistant' && message.content.trim() !== ''));

aiRouter.get('/status', aiReadLimiter, (_req: AuthRequest, res) => {
  const registry = getToolRegistry();
  res.json({ ...publicAiStatus(getAiConfig()), tools: registry.all().length, locales: LOCALES });
});

aiRouter.get('/capabilities', aiReadLimiter, (_req: AuthRequest, res) => {
  const tools = getToolRegistry()
    .all()
    .map((tool) => ({
      name: tool.name,
      domain: tool.domain,
      description: tool.description,
      risk: tool.risk,
      // Reported for the strictest case; a few tools only ask above a size threshold.
      confirmation: tool.risk !== 'low',
      audited: tool.audit,
    }));
  res.json({ tools });
});

aiRouter.get('/conversations', aiReadLimiter, async (req: AuthRequest, res, next) => {
  try {
    const rows = await getAgentStore().listConversations(req.user!.id, 50);
    res.json({ conversations: rows.map((c) => ({ id: c.id, title: c.title, locale: c.locale, updatedAt: c.updatedAt.toISOString() })) });
  } catch (error) {
    next(error);
  }
});

aiRouter.post('/conversations', aiReadLimiter, limitBody, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ locale: localeSchema.default('en'), title: z.string().trim().max(120).optional() }).parse(req.body ?? {});
    const conversation = await getAgentStore().createConversation(req.user!.id, body.locale, body.title ?? '');
    res.status(201).json({ conversation: { id: conversation.id, title: conversation.title, locale: conversation.locale, updatedAt: conversation.updatedAt.toISOString() } });
  } catch (error) {
    fail(res, next, error);
  }
});

aiRouter.get('/conversations/:id', aiReadLimiter, async (req: AuthRequest, res, next) => {
  try {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ code: 'NOT_FOUND', message: 'Conversation not found.' });
    const store = getAgentStore();
    const conversation = await store.getConversation(req.user!.id, id.data);
    if (!conversation) return res.status(404).json({ code: 'NOT_FOUND', message: 'Conversation not found.' });
    const [messages, tasks] = await Promise.all([store.listMessages(conversation.id, 200), store.listTasks(conversation.id, 20)]);
    const active = tasks.find((t) => !['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED', 'AWAITING_CLARIFICATION'].includes(t.status)) ?? null;
    return res.json({
      conversation: { id: conversation.id, title: conversation.title, locale: conversation.locale },
      messages: messages.filter(visible).map(messageDto),
      activeTaskId: active?.id ?? null,
    });
  } catch (error) {
    return fail(res, next, error);
  }
});

aiRouter.delete('/conversations/:id', aiReadLimiter, async (req: AuthRequest, res, next) => {
  try {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ code: 'NOT_FOUND', message: 'Conversation not found.' });
    const store = getAgentStore();
    const active = await store.activeTaskForConversation(id.data);
    if (active && active.userId === req.user!.id) await getAgent().cancel(req.user!.id, active.id).catch(() => undefined);
    const removed = await store.deleteConversation(req.user!.id, id.data);
    if (!removed) return res.status(404).json({ code: 'NOT_FOUND', message: 'Conversation not found.' });
    await createAuditLog(req.user!.id, 'AI_DELETE_CONVERSATION', 'ai_conversation', id.data);
    return res.json({ status: 'ok' });
  } catch (error) {
    return fail(res, next, error);
  }
});

aiRouter.post('/conversations/:id/messages', aiMessageLimiter, limitBody, async (req: AuthRequest, res, next) => {
  try {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ code: 'NOT_FOUND', message: 'Conversation not found.' });
    const body = z.object({ text: z.string().min(1).max(4000), locale: localeSchema.default('en') }).parse(req.body ?? {});
    const task = await getAgent().submitMessage(req.user!.id, id.data, body.text, body.locale);
    return res.status(202).json({ task: taskDto(task) });
  } catch (error) {
    return fail(res, next, error);
  }
});

aiRouter.get('/tasks/:id', aiReadLimiter, async (req: AuthRequest, res, next) => {
  try {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ code: 'NOT_FOUND', message: 'Task not found.' });
    const view = await getAgent().getTaskView(req.user!.id, id.data);
    if (!view) return res.status(404).json({ code: 'NOT_FOUND', message: 'Task not found.' });
    const afterSeq = z.coerce.number().int().min(0).default(0).parse(req.query.afterSeq ?? 0);
    const messages = (await getAgentStore().listMessages(view.task.conversationId, 200)).filter((m) => m.seq > afterSeq && visible(m));
    return res.json({
      task: taskDto(view.task),
      steps: view.executions.map(stepDto),
      confirmation: view.confirmation && view.confirmation.status === 'PENDING' ? confirmationDto(view.confirmation) : null,
      messages: messages.map(messageDto),
    });
  } catch (error) {
    return fail(res, next, error);
  }
});

aiRouter.post('/tasks/:id/cancel', aiReadLimiter, async (req: AuthRequest, res, next) => {
  try {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ code: 'NOT_FOUND', message: 'Task not found.' });
    const task = await getAgent().cancel(req.user!.id, id.data);
    return res.json({ task: taskDto(task) });
  } catch (error) {
    return fail(res, next, error);
  }
});

aiRouter.post('/confirmations/:id/approve', aiMessageLimiter, limitBody, async (req: AuthRequest, res, next) => {
  try {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ code: 'NOT_FOUND', message: 'Confirmation not found.' });
    const body = z.object({ argsHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }).parse(req.body ?? {});
    const task = await getAgent().approve(req.user!.id, id.data, body.argsHash);
    await createAuditLog(req.user!.id, 'AI_CONFIRMATION_APPROVED', 'ai_confirmation', id.data);
    return res.json({ task: taskDto(task) });
  } catch (error) {
    return fail(res, next, error);
  }
});

aiRouter.post('/confirmations/:id/reject', aiReadLimiter, async (req: AuthRequest, res, next) => {
  try {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ code: 'NOT_FOUND', message: 'Confirmation not found.' });
    const task = await getAgent().reject(req.user!.id, id.data);
    await createAuditLog(req.user!.id, 'AI_CONFIRMATION_REJECTED', 'ai_confirmation', id.data);
    return res.json({ task: taskDto(task) });
  } catch (error) {
    return fail(res, next, error);
  }
});

/**
 * Degraded mode: runs one READ-ONLY tool directly (no model). Works even when the AI provider is
 * down or unconfigured. Only low-risk tools that never need confirmation are reachable.
 */
aiRouter.post('/tools/:name/run', aiToolRunLimiter, limitBody, async (req: AuthRequest, res, next) => {
  try {
    const tool = getToolRegistry().get(String(req.params.name));
    if (!tool) return res.status(404).json({ code: 'TOOL_NOT_FOUND', message: 'Unknown tool.' });
    const parsed = parseToolArgs(tool, req.body?.args ?? {});
    if (!parsed.ok) return res.status(400).json({ code: 'VALIDATION_FAILED', message: parsed.message });
    if (tool.risk !== 'low' || requiresConfirmation(tool, parsed.args)) {
      return res.status(403).json({ code: 'TOOL_NOT_ALLOWED', message: 'Only read-only tools can be run directly. Ask the assistant to propose this action.' });
    }
    const outcome = await runTool(tool, parsed.args, { userId: req.user!.id, taskId: 'direct', config: getAiConfig(), signal: undefined, now: () => new Date() });
    if (!outcome.ok) return res.status(422).json({ code: outcome.code, message: outcome.message });
    const data = JSON.parse(toModelJson(outcome.result.data).json) as unknown;
    return res.json({ ok: true, summary: outcome.result.summary, data });
  } catch (error) {
    return fail(res, next, error);
  }
});
