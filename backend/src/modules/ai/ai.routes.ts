/**
 * AI assistant API (mounted at /ai). Every route is authenticated and user-scoped; the model never
 * sees or controls the user id. Long work runs as a persisted task that the client polls.
 */

import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, type AuthRequest } from '../../middleware/auth.middleware.js';
import { aiMessageLimiter, aiReadLimiter, aiToolRunLimiter } from '../../middleware/rate-limit.middleware.js';
import { createAuditLog } from '../../utils/audit.js';
import { AgentError } from './agent.js';
import { adminAiConfig, getAiConfig, loadAiConfig, publicAiStatus } from './config.js';
import { createProfileSchema, ProfileError, updateProfileSchema } from './profiles.js';
import { createModelProvider, ModelError } from './providers/index.js';
import { requiresConfirmation } from './policy.js';
import { cleanText, toModelJson } from './sanitize.js';
import { getAgent, getAgentStore, getProfileService, getToolRegistry } from './runtime.js';
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
  if (error instanceof ProfileError) return res.status(error.status).json({ code: error.code, message: error.message });
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

/**
 * Admin console. Requires the `admin` role (re-checked against the database by requireRole).
 * Exposes aggregates and ids only — never message text, tool arguments, keys or endpoints.
 */
const ADMIN_WINDOW_DAYS = 7;

aiRouter.get('/admin/overview', aiReadLimiter, requireRole('admin'), async (_req: AuthRequest, res, next) => {
  try {
    const since = new Date(Date.now() - ADMIN_WINDOW_DAYS * 86_400_000);
    const overview = await getAgentStore().adminOverview(since, ADMIN_WINDOW_DAYS, 25);
    res.json({
      config: adminAiConfig(getAiConfig()),
      toolCount: getToolRegistry().all().length,
      ...overview,
      recentTasks: overview.recentTasks.map((t) => ({
        id: t.id,
        userId: t.userId,
        status: t.status,
        stepCount: t.stepCount,
        toolCallCount: t.toolCallCount,
        provider: t.provider,
        model: t.model,
        error: t.error ? cleanText(t.error, 300) : null,
        createdAt: t.createdAt.toISOString(),
        finishedAt: t.finishedAt?.toISOString() ?? null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/** Sends one tiny, tool-less request to the configured model to prove the key/endpoint/model work. */
aiRouter.post('/admin/test', aiToolRunLimiter, requireRole('admin'), async (req: AuthRequest, res, next) => {
  const config = getAiConfig();
  if (!config.enabled) return res.status(409).json({ code: 'AI_DISABLED', message: config.reason ?? 'The AI assistant is not configured.' });
  const started = Date.now();
  try {
    const provider = createModelProvider(config);
    const response = await provider.complete({
      system: 'Reply with the single word: ok',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [],
      maxOutputTokens: 16,
    });
    await createAuditLog(req.user!.id, 'AI_ADMIN_TEST', 'ai_provider', config.provider ?? 'unknown');
    return res.json({ ok: true, latencyMs: Date.now() - started, model: provider.model, tokens: response.usage });
  } catch (error) {
    if (ModelError.is(error)) return res.status(200).json({ ok: false, latencyMs: Date.now() - started, code: error.code });
    return next(error);
  }
});

/** Model management. Keys are write-only: they are encrypted at rest and never returned. */
const profileId = (req: Request) => idParam.safeParse(req.params.id);
const notFound = (res: Response) => res.status(404).json({ code: 'NOT_FOUND', message: 'Model not found.' });

aiRouter.get('/admin/models', aiReadLimiter, requireRole('admin'), async (_req: AuthRequest, res, next) => {
  try {
    res.json({ ...(await getProfileService().list()), environment: adminAiConfig(loadAiConfig(process.env)), effective: adminAiConfig(getAiConfig()) });
  } catch (error) {
    next(error);
  }
});

aiRouter.post('/admin/models', aiReadLimiter, requireRole('admin'), limitBody, async (req: AuthRequest, res, next) => {
  try {
    const input = createProfileSchema.parse(req.body ?? {});
    const profile = await getProfileService().create(input);
    await createAuditLog(req.user!.id, 'AI_MODEL_CREATED', 'ai_model_profile', profile.id, { provider: profile.provider, model: profile.model });
    res.status(201).json({ profile });
  } catch (error) {
    fail(res, next, error);
  }
});

// Registered before /admin/models/:id/* so "test" is never read as an id.
aiRouter.post('/admin/models/test', aiToolRunLimiter, requireRole('admin'), limitBody, async (req: AuthRequest, res, next) => {
  try {
    const body = createProfileSchema.extend({ existingId: z.string().uuid().optional() }).parse(req.body ?? {});
    const result = await getProfileService().testDraft(body, body.existingId);
    await createAuditLog(req.user!.id, 'AI_MODEL_TESTED', 'ai_model_profile', body.existingId ?? 'draft', { ok: result.ok, code: result.code });
    res.json(result);
  } catch (error) {
    fail(res, next, error);
  }
});

aiRouter.post('/admin/models/use-environment', aiReadLimiter, requireRole('admin'), async (req: AuthRequest, res, next) => {
  try {
    await getProfileService().useEnvironment();
    await createAuditLog(req.user!.id, 'AI_MODEL_USE_ENVIRONMENT', 'ai_model_profile', 'environment');
    res.json({ status: 'ok', effective: adminAiConfig(getAiConfig()) });
  } catch (error) {
    next(error);
  }
});

aiRouter.patch('/admin/models/:id', aiReadLimiter, requireRole('admin'), limitBody, async (req: AuthRequest, res, next) => {
  try {
    const id = profileId(req);
    if (!id.success) return notFound(res);
    const input = updateProfileSchema.parse(req.body ?? {});
    const profile = await getProfileService().update(id.data, input);
    await createAuditLog(req.user!.id, 'AI_MODEL_UPDATED', 'ai_model_profile', id.data);
    return res.json({ profile, effective: adminAiConfig(getAiConfig()) });
  } catch (error) {
    return fail(res, next, error);
  }
});

aiRouter.delete('/admin/models/:id', aiReadLimiter, requireRole('admin'), async (req: AuthRequest, res, next) => {
  try {
    const id = profileId(req);
    if (!id.success) return notFound(res);
    await getProfileService().remove(id.data);
    await createAuditLog(req.user!.id, 'AI_MODEL_DELETED', 'ai_model_profile', id.data);
    return res.json({ status: 'ok', effective: adminAiConfig(getAiConfig()) });
  } catch (error) {
    return fail(res, next, error);
  }
});

aiRouter.post('/admin/models/:id/activate', aiReadLimiter, requireRole('admin'), async (req: AuthRequest, res, next) => {
  try {
    const id = profileId(req);
    if (!id.success) return notFound(res);
    const profile = await getProfileService().activate(id.data);
    await createAuditLog(req.user!.id, 'AI_MODEL_ACTIVATED', 'ai_model_profile', id.data, { provider: profile.provider, model: profile.model });
    return res.json({ profile, effective: adminAiConfig(getAiConfig()) });
  } catch (error) {
    return fail(res, next, error);
  }
});

aiRouter.post('/admin/models/:id/test', aiToolRunLimiter, requireRole('admin'), async (req: AuthRequest, res, next) => {
  try {
    const id = profileId(req);
    if (!id.success) return notFound(res);
    const result = await getProfileService().test(id.data);
    await createAuditLog(req.user!.id, 'AI_MODEL_TESTED', 'ai_model_profile', id.data, { ok: result.ok, code: result.code });
    return res.json(result);
  } catch (error) {
    return fail(res, next, error);
  }
});

/** Lets an admin stop any user's running task (e.g. a runaway request). Audited. */
aiRouter.post('/admin/tasks/:id/cancel', aiReadLimiter, requireRole('admin'), async (req: AuthRequest, res, next) => {
  try {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ code: 'NOT_FOUND', message: 'Task not found.' });
    const task = await getAgentStore().getTask(id.data);
    if (!task) return res.status(404).json({ code: 'NOT_FOUND', message: 'Task not found.' });
    const cancelled = await getAgent().cancel(task.userId, task.id);
    await createAuditLog(req.user!.id, 'AI_ADMIN_CANCEL_TASK', 'ai_task', task.id);
    return res.json({ task: taskDto(cancelled) });
  } catch (error) {
    return fail(res, next, error);
  }
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
