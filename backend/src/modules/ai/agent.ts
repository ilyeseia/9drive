/**
 * Bounded agent orchestrator (docs/ai-agent-architecture.md §2–§4).
 *
 * The model PROPOSES tool calls; this module validates, authorises (via userId-scoped tools),
 * gates on risk policy, executes, verifies and records. Hard limits (steps, tool calls, wall time,
 * tokens, concurrency) bound every task. Confirmation is stored server-side, bound to the exact
 * arguments, and can only be granted through `approve()` — which is reachable only from an
 * authenticated user request, never from model output.
 */

import { createAuditLog } from '../../utils/audit.js';
import type { AiConfig } from './config.js';
import { hashArgs, requiresConfirmation } from './policy.js';
import { buildSystemPrompt } from './prompts.js';
import { ModelError, type ChatMessage, type ModelProvider, type ToolCall } from './providers/types.js';
import { toModelJson, wrapUntrusted, cleanText } from './sanitize.js';
import {
  TASK_STATUS,
  TERMINAL_STATUSES,
  type AgentStore,
  type ConfirmationRecord,
  type ExecutionRecord,
  type MessageRecord,
  type TaskRecord,
  type TaskStatus,
} from './store.js';
import { parseToolArgs, runTool, type ToolRegistry } from './tools/registry.js';
import { ToolError, type AnyTool, type ConfirmationPreview, type ToolContext } from './tools/types.js';

export class AgentError extends Error {
  constructor(
    readonly code:
      | 'AI_NOT_CONFIGURED'
      | 'NOT_FOUND'
      | 'TASK_IN_PROGRESS'
      | 'TOO_MANY_TASKS'
      | 'SERVER_BUSY'
      | 'USAGE_LIMIT_REACHED'
      | 'CONFIRMATION_EXPIRED'
      | 'CONFIRMATION_USED'
      | 'CONFIRMATION_MISMATCH'
      | 'CONFIRMATION_INVALID'
      | 'TASK_CANCELLED'
      | 'INVALID_INPUT',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export interface AgentDeps {
  store: AgentStore;
  registry: ToolRegistry;
  config: AiConfig;
  provider: () => ModelProvider;
  now?: () => Date;
  audit?: (userId: string, action: string, entityType: string, entityId?: string, metadata?: unknown) => Promise<void>;
  /** Runs background work; defaults to fire-and-forget. Tests inject a collector they can await. */
  schedule?: (work: () => Promise<void>) => void;
}

const MAX_HISTORY_CHARS = 80_000;
const MAX_USER_TEXT = 4_000;

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export class AgentOrchestrator {
  private readonly running = new Map<string, AbortController>();
  private readonly now: () => Date;
  private readonly audit: NonNullable<AgentDeps['audit']>;
  private readonly schedule: NonNullable<AgentDeps['schedule']>;

  constructor(private readonly deps: AgentDeps) {
    this.now = deps.now ?? (() => new Date());
    this.audit = deps.audit ?? ((userId, action, entityType, entityId, metadata) => createAuditLog(userId, action, entityType, entityId, metadata));
    this.schedule =
      deps.schedule ??
      ((work) => {
        void work().catch((error: unknown) => console.error('[ai] background task crashed', error instanceof Error ? error.message : 'unknown'));
      });
  }

  /** Marks tasks left in a running state by a previous process as failed. Call once at boot. */
  async recoverOrphans(): Promise<number> {
    return this.deps.store.failOrphans(new Date(this.now().getTime() - 5_000));
  }

  runningCount(): number {
    return this.running.size;
  }

  // ---- public entry points -------------------------------------------------------------

  async submitMessage(userId: string, conversationId: string, text: string, locale: string): Promise<TaskRecord> {
    const { store, config } = this.deps;
    if (!config.enabled) throw new AgentError('AI_NOT_CONFIGURED', config.reason ?? 'The AI assistant is not configured.', 503);
    const clean = text.replace(/\u0000/g, '').trim();
    if (clean === '' || clean.length > MAX_USER_TEXT) throw new AgentError('INVALID_INPUT', `Messages must be 1-${MAX_USER_TEXT} characters.`, 400);

    const conversation = await store.getConversation(userId, conversationId);
    if (!conversation) throw new AgentError('NOT_FOUND', 'Conversation not found.', 404);
    if (await store.activeTaskForConversation(conversationId)) {
      throw new AgentError('TASK_IN_PROGRESS', 'Another request in this conversation is still running or waiting for confirmation.', 409);
    }
    if (this.running.size >= config.maxConcurrentTasks) throw new AgentError('SERVER_BUSY', 'The assistant is busy. Try again shortly.', 503);
    const mine = [...this.running.keys()];
    let mineCount = 0;
    for (const id of mine) if ((await store.getTask(id))?.userId === userId) mineCount += 1;
    if (mineCount >= config.maxConcurrentTasksPerUser) throw new AgentError('TOO_MANY_TASKS', 'Too many assistant requests are running at once.', 429);
    await this.assertWithinDailyLimit(userId);

    await store.appendMessage(conversationId, { role: 'user', content: clean });
    if (!conversation.title) await store.updateConversation(conversationId, { title: cleanText(clean, 60), locale });
    else if (conversation.locale !== locale) await store.updateConversation(conversationId, { locale });

    const task = await store.createTask({ conversationId, userId, provider: config.provider, model: config.model });
    this.schedule(() => this.runLoop(task.id, locale));
    return task;
  }

  async cancel(userId: string, taskId: string): Promise<TaskRecord> {
    const { store } = this.deps;
    const task = await store.getTaskForUser(userId, taskId);
    if (!task) throw new AgentError('NOT_FOUND', 'Task not found.', 404);
    if (TERMINAL_STATUSES.has(task.status)) return task;
    const pending = task.pending;
    const changed = await store.transitionTask(
      task.id,
      [TASK_STATUS.RECEIVED, TASK_STATUS.ANALYZING, TASK_STATUS.AWAITING_CONFIRMATION, TASK_STATUS.EXECUTING, TASK_STATUS.VERIFYING],
      TASK_STATUS.CANCELLED,
      { pending: null, error: 'Cancelled by the user.' },
    );
    if (changed && pending) {
      await store.closeConfirmation(pending.confirmationId, userId, 'REJECTED', this.now());
      await this.recordToolResult(task, pending.toolCallId, null, 'REJECTED', 'The task was cancelled before this action was approved. Nothing was executed.', 'CANCELLED');
    }
    this.running.get(task.id)?.abort();
    return (await store.getTask(task.id)) ?? task;
  }

  /** Approves a pending confirmation and executes exactly the stored arguments, once. */
  async approve(userId: string, confirmationId: string, expectedArgsHash?: string): Promise<TaskRecord> {
    const { store, registry } = this.deps;
    const confirmation = await store.getConfirmationForUser(userId, confirmationId);
    if (!confirmation) throw new AgentError('NOT_FOUND', 'Confirmation not found.', 404);
    if (expectedArgsHash !== undefined && expectedArgsHash !== confirmation.argsHash) {
      throw new AgentError('CONFIRMATION_MISMATCH', 'The action no longer matches what was shown. Review it again.', 409);
    }
    const task = await store.getTask(confirmation.taskId);
    if (!task || task.userId !== userId) throw new AgentError('NOT_FOUND', 'Confirmation not found.', 404);
    if (task.status !== TASK_STATUS.AWAITING_CONFIRMATION || task.pending?.confirmationId !== confirmation.id) {
      throw new AgentError(confirmation.status === 'PENDING' ? 'CONFIRMATION_INVALID' : 'CONFIRMATION_USED', 'This confirmation can no longer be used.', 409);
    }

    const consumed = await store.consumeConfirmation(confirmation.id, userId, this.now());
    if (!consumed) {
      const latest = await store.getConfirmationForUser(userId, confirmation.id);
      if (latest && latest.status === 'PENDING') {
        // Pending but not consumable ⇒ past its expiry.
        await this.expireConfirmation(task, latest);
        throw new AgentError('CONFIRMATION_EXPIRED', 'This confirmation expired. Ask the assistant to propose the action again.', 410);
      }
      throw new AgentError('CONFIRMATION_USED', 'This confirmation was already used or closed.', 409);
    }

    // Defence in depth: the stored arguments must still hash to what was shown to the user.
    if (hashArgs(consumed.toolName, consumed.args) !== consumed.argsHash) {
      await this.recordToolResult(task, consumed.toolCallId, consumed.toolName, 'FAILED', 'The stored action was altered; it was not executed.', 'TAMPERED');
      await store.transitionTask(task.id, [TASK_STATUS.AWAITING_CONFIRMATION], TASK_STATUS.ANALYZING, { pending: null });
      this.schedule(() => this.runLoop(task.id, null));
      throw new AgentError('CONFIRMATION_INVALID', 'The stored action failed its integrity check.', 409);
    }

    const tool = registry.get(consumed.toolName);
    const parsed = tool ? parseToolArgs(tool, consumed.args) : null;
    if (!tool || !parsed || !parsed.ok) {
      await this.recordToolResult(task, consumed.toolCallId, consumed.toolName, 'FAILED', 'The action is no longer valid.', 'INVALID_ARGUMENTS');
      await store.transitionTask(task.id, [TASK_STATUS.AWAITING_CONFIRMATION], TASK_STATUS.ANALYZING, { pending: null });
      this.schedule(() => this.runLoop(task.id, null));
      throw new AgentError('CONFIRMATION_INVALID', 'The action is no longer valid.', 409);
    }

    const moved = await store.transitionTask(task.id, [TASK_STATUS.AWAITING_CONFIRMATION], TASK_STATUS.EXECUTING, { pending: null });
    if (!moved) throw new AgentError('TASK_CANCELLED', 'The task was cancelled.', 409);

    const controller = new AbortController();
    this.running.set(task.id, controller);
    try {
      await this.executeAndRecord(task, tool, { id: consumed.toolCallId, name: consumed.toolName, arguments: consumed.args, rawArguments: '' }, parsed.args, controller.signal, consumed.id);
    } finally {
      this.running.delete(task.id);
    }
    await store.transitionTask(task.id, [TASK_STATUS.EXECUTING, TASK_STATUS.VERIFYING], TASK_STATUS.ANALYZING);
    this.schedule(() => this.runLoop(task.id, null));
    return (await store.getTask(task.id)) ?? task;
  }

  async reject(userId: string, confirmationId: string): Promise<TaskRecord> {
    const { store } = this.deps;
    const confirmation = await store.getConfirmationForUser(userId, confirmationId);
    if (!confirmation) throw new AgentError('NOT_FOUND', 'Confirmation not found.', 404);
    const task = await store.getTask(confirmation.taskId);
    if (!task || task.userId !== userId) throw new AgentError('NOT_FOUND', 'Confirmation not found.', 404);
    const closed = await store.closeConfirmation(confirmation.id, userId, 'REJECTED', this.now());
    if (!closed) throw new AgentError('CONFIRMATION_USED', 'This confirmation was already used or closed.', 409);
    await this.recordToolResult(task, confirmation.toolCallId, confirmation.toolName, 'REJECTED', 'The user declined this action. Nothing was executed.', 'DECLINED');
    const moved = await store.transitionTask(task.id, [TASK_STATUS.AWAITING_CONFIRMATION], TASK_STATUS.ANALYZING, { pending: null });
    if (moved) this.schedule(() => this.runLoop(task.id, null));
    return (await store.getTask(task.id)) ?? task;
  }

  /** Task read used by the API: also resolves confirmations that expired while the user was away. */
  async getTaskView(userId: string, taskId: string): Promise<{ task: TaskRecord; executions: ExecutionRecord[]; confirmation: ConfirmationRecord | null } | null> {
    const { store } = this.deps;
    let task = await store.getTaskForUser(userId, taskId);
    if (!task) return null;
    let confirmation: ConfirmationRecord | null = null;
    if (task.pending) {
      confirmation = await store.getConfirmationForUser(userId, task.pending.confirmationId);
      if (confirmation && confirmation.status === 'PENDING' && confirmation.expiresAt.getTime() <= this.now().getTime()) {
        await this.expireConfirmation(task, confirmation);
        task = (await store.getTask(taskId)) ?? task;
        confirmation = await store.getConfirmationForUser(userId, confirmation.id);
      }
    }
    return { task, executions: await store.listExecutions(taskId), confirmation };
  }

  // ---- internals -----------------------------------------------------------------------

  private async expireConfirmation(task: TaskRecord, confirmation: ConfirmationRecord): Promise<void> {
    const { store } = this.deps;
    const closed = await store.closeConfirmation(confirmation.id, task.userId, 'EXPIRED', this.now());
    if (!closed) return;
    await this.recordToolResult(task, confirmation.toolCallId, confirmation.toolName, 'REJECTED', 'The confirmation expired. Nothing was executed.', 'EXPIRED');
    const moved = await store.transitionTask(task.id, [TASK_STATUS.AWAITING_CONFIRMATION], TASK_STATUS.ANALYZING, { pending: null });
    if (moved) this.schedule(() => this.runLoop(task.id, null));
  }

  private async assertWithinDailyLimit(userId: string): Promise<void> {
    const limit = this.deps.config.dailyTokenLimit;
    if (limit === null) return;
    const used = await this.deps.store.tokensSince(userId, startOfUtcDay(this.now()));
    if (used >= limit) throw new AgentError('USAGE_LIMIT_REACHED', 'The daily AI usage limit has been reached.', 429);
  }

  private async finish(task: TaskRecord, status: TaskStatus, error: string | null, assistantNote?: string): Promise<void> {
    const { store } = this.deps;
    if (assistantNote) await store.appendMessage(task.conversationId, { role: 'assistant', content: assistantNote, taskId: task.id });
    await store.transitionTask(
      task.id,
      [TASK_STATUS.RECEIVED, TASK_STATUS.ANALYZING, TASK_STATUS.EXECUTING, TASK_STATUS.VERIFYING, TASK_STATUS.AWAITING_CONFIRMATION],
      status,
      { error, pending: null },
    );
  }

  private async runLoop(taskId: string, locale: string | null): Promise<void> {
    const { store, config } = this.deps;
    const controller = new AbortController();
    this.running.set(taskId, controller);
    const started = Date.now();
    try {
      let task = await store.getTask(taskId);
      if (!task) return;
      const conversation = await store.getConversation(task.userId, task.conversationId);
      const language = locale ?? conversation?.locale ?? 'en';
      const entered = await store.transitionTask(task.id, [TASK_STATUS.RECEIVED, TASK_STATUS.ANALYZING], TASK_STATUS.ANALYZING);
      if (!entered) return;

      for (;;) {
        task = await store.getTask(taskId);
        if (!task || task.status === TASK_STATUS.CANCELLED) return;
        if (task.stepCount >= config.maxSteps) {
          await this.finish(task, TASK_STATUS.PARTIALLY_COMPLETED, 'Step limit reached.', 'I reached the maximum number of steps for one request, so I stopped. Tell me whether to continue.');
          return;
        }
        if (Date.now() - started > config.taskTimeoutMs) {
          await this.finish(task, TASK_STATUS.FAILED, 'Task time limit reached.', 'This request took too long and was stopped. Nothing further was executed.');
          return;
        }
        try {
          await this.assertWithinDailyLimit(task.userId);
        } catch {
          await this.finish(task, TASK_STATUS.FAILED, 'Daily usage limit reached.', 'The daily AI usage limit has been reached. Try again tomorrow.');
          return;
        }

        const history = await this.buildHistory(task.conversationId);
        let response;
        try {
          response = await this.deps.provider().complete({
            system: buildSystemPrompt(language, this.now()),
            messages: history,
            tools: this.deps.registry.specs(),
            maxOutputTokens: config.maxOutputTokens,
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          const model = ModelError.is(error) ? error : null;
          const text = model ? model.message : 'The AI model failed unexpectedly.';
          const fresh = (await store.getTask(taskId)) ?? task;
          await this.finish(fresh, TASK_STATUS.FAILED, model?.code ?? 'MODEL_ERROR', `I could not get an answer from the AI model: ${text} Read-only quick actions still work.`);
          return;
        }

        task = await store.updateTask(task.id, { stepCount: task.stepCount + 1 });
        if (response.usage) {
          await store
            .recordUsage({ userId: task.userId, taskId: task.id, provider: config.provider ?? 'unknown', model: config.model ?? 'unknown', ...response.usage })
            .catch(() => undefined);
        }
        if ((await store.getTask(taskId))?.status === TASK_STATUS.CANCELLED) return;

        await store.appendMessage(task.conversationId, {
          role: 'assistant',
          content: response.text,
          toolCalls: response.toolCalls.length > 0 ? response.toolCalls : null,
          taskId: task.id,
        });

        if (response.toolCalls.length === 0) {
          await this.finalise(task, response.text, response.stopReason === 'length');
          return;
        }
        const paused = await this.processCalls(task, response.toolCalls, controller.signal);
        if (paused) return;
        await store.transitionTask(task.id, [TASK_STATUS.EXECUTING, TASK_STATUS.VERIFYING], TASK_STATUS.ANALYZING);
      }
    } catch (error) {
      console.error('[ai] task loop failed', error instanceof Error ? error.message : 'unknown');
      const task = await store.getTask(taskId).catch(() => null);
      if (task) await this.finish(task, TASK_STATUS.FAILED, 'Internal error.', 'Something went wrong while processing this request.').catch(() => undefined);
    } finally {
      this.running.delete(taskId);
    }
  }

  /** Decides the terminal status from what was ACTUALLY executed, not from what the model says. */
  private async finalise(task: TaskRecord, finalText: string, truncated: boolean): Promise<void> {
    const executions = await this.deps.store.listExecutions(task.id);
    const mutating = executions.filter((e) => this.deps.registry.get(e.toolName)?.risk !== 'low');
    // Calls rejected before running (bad arguments, unknown tool, not-found/unauthorised ids, budget)
    // changed nothing: they only matter when nothing else succeeded (the model may have self-corrected).
    const SOFT = new Set(['INVALID_ARGUMENTS', 'UNSUPPORTED', 'LIMIT_EXCEEDED', 'NOT_FOUND', 'FORBIDDEN']);
    const failedHard = mutating.filter((e) => e.status === 'FAILED' && !SOFT.has(e.errorCode ?? '')).length;
    const failedSoft = mutating.filter((e) => e.status === 'FAILED' && SOFT.has(e.errorCode ?? '')).length;
    const succeeded = mutating.filter((e) => e.status === 'SUCCEEDED').length;
    const partial = executions.some((e) => e.errorCode === 'PARTIAL');
    let status: TaskStatus = TASK_STATUS.COMPLETED;
    if (executions.length === 0 && /[?؟]\s*$/.test(finalText.trim())) status = TASK_STATUS.AWAITING_CLARIFICATION;
    else if (failedHard > 0) status = succeeded > 0 ? TASK_STATUS.PARTIALLY_COMPLETED : TASK_STATUS.FAILED;
    else if (failedSoft > 0 && succeeded === 0) status = TASK_STATUS.FAILED;
    else if (partial || truncated) status = TASK_STATUS.PARTIALLY_COMPLETED;
    await this.deps.store.transitionTask(task.id, [TASK_STATUS.ANALYZING, TASK_STATUS.EXECUTING, TASK_STATUS.VERIFYING], status, { error: null, pending: null });
  }

  /** Returns true when the task paused for a confirmation. */
  private async processCalls(task: TaskRecord, calls: ToolCall[], signal: AbortSignal): Promise<boolean> {
    const { store, registry, config } = this.deps;
    let paused = false;
    let used = task.toolCallCount;
    for (const call of calls) {
      if (paused) {
        await this.recordToolResult(task, call.id, call.name, 'SKIPPED', 'Not executed: a previous action in this turn is waiting for the user\'s confirmation. Propose this call again afterwards if it is still needed.', 'SKIPPED');
        continue;
      }
      const prior = await store.findExecution(task.id, call.id);
      if (prior && prior.status !== 'PENDING_CONFIRMATION') {
        // Idempotency: a call id that already ran is never executed twice.
        await this.ensureToolMessage(task, prior);
        continue;
      }
      if (used >= config.maxToolCalls) {
        await this.recordToolResult(task, call.id, call.name, 'SKIPPED', 'Not executed: the tool-call limit for this request was reached.', 'LIMIT_EXCEEDED');
        continue;
      }
      used += 1;
      task = await store.updateTask(task.id, { toolCallCount: used });

      const tool = registry.get(call.name);
      if (!tool) {
        await this.recordToolResult(task, call.id, call.name, 'FAILED', `Unknown tool "${cleanText(call.name, 64)}". Only the listed tools exist.`, 'UNSUPPORTED');
        continue;
      }
      const parsed = parseToolArgs(tool, call.arguments);
      if (!parsed.ok) {
        await this.recordToolResult(task, call.id, call.name, 'FAILED', `Invalid arguments: ${parsed.message}`, 'INVALID_ARGUMENTS', call.arguments);
        continue;
      }

      if (requiresConfirmation(tool, parsed.args)) {
        const ctx = this.contextFor(task, signal);
        let preview: ConfirmationPreview;
        try {
          preview = tool.preview
            ? await tool.preview(parsed.args, ctx)
            : { summary: `${tool.name} ${JSON.stringify(parsed.args).slice(0, 300)}`, affectedCount: 1, sample: [], warnings: [] };
        } catch (error) {
          const code = error instanceof ToolError ? error.code : 'INTERNAL';
          const message = error instanceof ToolError ? error.message : 'The action could not be prepared.';
          await this.recordToolResult(task, call.id, call.name, 'FAILED', message, code, parsed.args);
          continue;
        }
        const confirmation = await store.createConfirmation({
          userId: task.userId,
          taskId: task.id,
          toolName: tool.name,
          toolCallId: call.id,
          args: parsed.args,
          argsHash: hashArgs(tool.name, parsed.args),
          summary: cleanText(preview.summary, 600),
          preview,
          risk: tool.risk,
          expiresAt: new Date(this.now().getTime() + config.confirmationTtlSeconds * 1000),
        });
        await store.saveExecution({
          taskId: task.id,
          userId: task.userId,
          toolName: tool.name,
          toolCallId: call.id,
          args: parsed.args,
          status: 'PENDING_CONFIRMATION',
          summary: confirmation.summary,
          verification: null,
          userOutput: null,
          errorCode: null,
          confirmationId: confirmation.id,
          latencyMs: null,
        });
        await store.transitionTask(task.id, [TASK_STATUS.ANALYZING, TASK_STATUS.EXECUTING, TASK_STATUS.VERIFYING], TASK_STATUS.AWAITING_CONFIRMATION, {
          pending: { confirmationId: confirmation.id, toolCallId: call.id },
        });
        paused = true;
        continue;
      }
      await this.executeAndRecord(task, tool, call, parsed.args, signal, null);
    }
    return paused;
  }

  private contextFor(task: TaskRecord, signal?: AbortSignal): ToolContext {
    return { userId: task.userId, taskId: task.id, config: this.deps.config, signal, now: this.now };
  }

  private async executeAndRecord(task: TaskRecord, tool: AnyTool, call: ToolCall, args: unknown, signal: AbortSignal, confirmationId: string | null): Promise<void> {
    const { store } = this.deps;
    await store.transitionTask(task.id, [TASK_STATUS.ANALYZING, TASK_STATUS.EXECUTING], TASK_STATUS.EXECUTING);
    const started = Date.now();
    const outcome = await runTool(tool, args, this.contextFor(task, signal));
    const latency = Date.now() - started;
    if (outcome.ok && outcome.result.verification) await store.transitionTask(task.id, [TASK_STATUS.EXECUTING], TASK_STATUS.VERIFYING);

    if (outcome.ok) {
      const modelView = toModelJson({
        ok: true,
        summary: outcome.result.summary,
        verification: outcome.result.verification ?? null,
        partial: outcome.result.partial ?? false,
        data: outcome.result.data,
        ...(outcome.result.userOutput ? { note: 'Additional details were shown to the user directly and are intentionally not visible to you.' } : {}),
      });
      await store.saveExecution({
        taskId: task.id,
        userId: task.userId,
        toolName: tool.name,
        toolCallId: call.id,
        args,
        status: 'SUCCEEDED',
        summary: cleanText(outcome.result.summary, 600),
        verification: outcome.result.verification ? cleanText(outcome.result.verification, 600) : null,
        userOutput: outcome.result.userOutput ?? null,
        errorCode: outcome.result.partial ? 'PARTIAL' : null,
        confirmationId,
        latencyMs: latency,
      });
      await store.appendMessage(task.conversationId, { role: 'tool', content: wrapUntrusted(modelView.json), toolCallId: call.id, taskId: task.id });
    } else {
      await this.recordToolResult(task, call.id, tool.name, 'FAILED', outcome.message, outcome.code, args, latency, confirmationId);
    }
    if (tool.risk !== 'low' || tool.audit) {
      await this.audit(task.userId, 'AI_TOOL_EXECUTED', 'ai_task', task.id, {
        tool: tool.name,
        status: outcome.ok ? 'succeeded' : 'failed',
        confirmationId,
        code: outcome.ok ? null : outcome.code,
      });
    }
  }

  /** Persists a non-success result and the matching tool message the model will see. */
  private async recordToolResult(
    task: TaskRecord,
    toolCallId: string,
    toolName: string | null,
    status: ExecutionRecord['status'],
    message: string,
    code: string,
    args: unknown = {},
    latencyMs: number | null = null,
    confirmationId: string | null = null,
  ): Promise<void> {
    const { store } = this.deps;
    const existing = await store.findExecution(task.id, toolCallId);
    await store.saveExecution({
      taskId: task.id,
      userId: task.userId,
      toolName: toolName ?? existing?.toolName ?? 'unknown',
      toolCallId,
      args: existing?.args ?? args ?? {},
      status,
      summary: cleanText(message, 600),
      verification: null,
      userOutput: null,
      errorCode: code,
      confirmationId: confirmationId ?? existing?.confirmationId ?? null,
      latencyMs,
    });
    const content = toModelJson({ ok: false, status, code, message });
    await store.appendMessage(task.conversationId, { role: 'tool', content: wrapUntrusted(content.json), toolCallId, taskId: task.id });
  }

  private async ensureToolMessage(task: TaskRecord, execution: ExecutionRecord): Promise<void> {
    const messages = await this.deps.store.listMessages(task.conversationId, 500);
    if (messages.some((m) => m.role === 'tool' && m.toolCallId === execution.toolCallId)) return;
    const content = toModelJson({ ok: execution.status === 'SUCCEEDED', status: execution.status, message: execution.summary });
    await this.deps.store.appendMessage(task.conversationId, { role: 'tool', content: wrapUntrusted(content.json), toolCallId: execution.toolCallId, taskId: task.id });
  }

  /**
   * Bounded history for the model: last N messages within a character budget, with orphaned tool
   * calls/results repaired so every provider accepts the transcript.
   */
  private async buildHistory(conversationId: string): Promise<ChatMessage[]> {
    const rows = await this.deps.store.listMessages(conversationId, this.deps.config.historyMaxMessages);
    return repairHistory(rows, MAX_HISTORY_CHARS);
  }
}

export function repairHistory(rows: MessageRecord[], maxChars: number): ChatMessage[] {
  // Drop from the front until under budget, then until the first message is a user turn.
  let start = 0;
  let total = rows.reduce((sum, row) => sum + row.content.length + (row.toolCalls ? JSON.stringify(row.toolCalls).length : 0), 0);
  while (total > maxChars && start < rows.length - 1) {
    total -= rows[start].content.length + (rows[start].toolCalls ? JSON.stringify(rows[start].toolCalls).length : 0);
    start += 1;
  }
  while (start < rows.length && rows[start].role !== 'user') start += 1;
  const window = rows.slice(start);

  const answered = new Set(window.filter((row) => row.role === 'tool' && row.toolCallId).map((row) => row.toolCallId as string));
  const out: ChatMessage[] = [];
  for (let i = 0; i < window.length; i++) {
    const row = window[i];
    if (row.role === 'tool') {
      // A tool result is only valid directly after the assistant turn that issued the call.
      const issuer = [...window.slice(0, i)].reverse().find((r) => r.role === 'assistant' && r.toolCalls?.some((c) => c.id === row.toolCallId));
      if (issuer) out.push({ role: 'tool', content: row.content, toolCallId: row.toolCallId ?? '' });
      continue;
    }
    if (row.role === 'assistant') {
      out.push({ role: 'assistant', content: row.content, toolCalls: row.toolCalls ?? undefined });
      for (const call of row.toolCalls ?? []) {
        if (answered.has(call.id)) continue;
        const toolRows = window.filter((r) => r.role === 'tool' && r.toolCallId === call.id);
        if (toolRows.length === 0) {
          out.push({
            role: 'tool',
            toolCallId: call.id,
            content: wrapUntrusted(JSON.stringify({ ok: false, message: 'Result unavailable: the action was interrupted.' })),
          });
        }
      }
      continue;
    }
    out.push({ role: 'user', content: row.content });
  }
  // Providers need tool results to follow their assistant turn; move each result up behind its issuer.
  return orderToolResults(out);
}

function orderToolResults(messages: ChatMessage[]): ChatMessage[] {
  const results = new Map<string, ChatMessage>();
  for (const message of messages) if (message.role === 'tool' && message.toolCallId) results.set(message.toolCallId, message);
  const ordered: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') continue;
    ordered.push(message);
    for (const call of message.toolCalls ?? []) {
      const result = results.get(call.id);
      if (result) ordered.push(result);
    }
  }
  return ordered;
}
