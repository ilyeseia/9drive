/** In-memory AgentStore with the same atomic semantics as the Prisma store (tests/tooling). */

import { randomUUID } from 'node:crypto';
import {
  TASK_STATUS,
  TERMINAL_STATUSES,
  type AgentStore,
  type ConfirmationRecord,
  type ConversationRecord,
  type ExecutionRecord,
  type MessageRecord,
  type TaskRecord,
} from './store.js';

export function createMemoryStore(now: () => Date = () => new Date()): AgentStore & {
  data: {
    conversations: Map<string, ConversationRecord>;
    messages: MessageRecord[];
    tasks: Map<string, TaskRecord>;
    executions: ExecutionRecord[];
    confirmations: Map<string, ConfirmationRecord>;
    usage: Array<{ userId: string; tokens: number; at: Date }>;
  };
} {
  const data = {
    conversations: new Map<string, ConversationRecord>(),
    messages: [] as MessageRecord[],
    tasks: new Map<string, TaskRecord>(),
    executions: [] as ExecutionRecord[],
    confirmations: new Map<string, ConfirmationRecord>(),
    usage: [] as Array<{ userId: string; tokens: number; at: Date }>,
  };
  const clone = <T>(value: T): T => structuredClone(value);

  return {
    data,
    async createConversation(userId, locale, title) {
      const record: ConversationRecord = { id: randomUUID(), userId, title, locale, createdAt: now(), updatedAt: now() };
      data.conversations.set(record.id, record);
      return clone(record);
    },
    async getConversation(userId, id) {
      const record = data.conversations.get(id);
      return record && record.userId === userId ? clone(record) : null;
    },
    async listConversations(userId, limit) {
      return [...data.conversations.values()]
        .filter((c) => c.userId === userId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit)
        .map(clone);
    },
    async deleteConversation(userId, id) {
      const record = data.conversations.get(id);
      if (!record || record.userId !== userId) return false;
      data.conversations.delete(id);
      data.messages = data.messages.filter((m) => m.conversationId !== id);
      for (const task of [...data.tasks.values()]) {
        if (task.conversationId !== id) continue;
        data.tasks.delete(task.id);
        data.executions = data.executions.filter((e) => e.taskId !== task.id);
        for (const [cid, conf] of data.confirmations) if (conf.taskId === task.id) data.confirmations.delete(cid);
      }
      return true;
    },
    async updateConversation(id, patch) {
      const record = data.conversations.get(id);
      if (record) Object.assign(record, patch, { updatedAt: now() });
    },
    async appendMessage(conversationId, input) {
      const seq = data.messages.filter((m) => m.conversationId === conversationId).length + 1;
      const record: MessageRecord = {
        id: randomUUID(),
        conversationId,
        seq,
        role: input.role,
        content: input.content,
        toolCalls: input.toolCalls ?? null,
        toolCallId: input.toolCallId ?? null,
        taskId: input.taskId ?? null,
        createdAt: now(),
      };
      data.messages.push(record);
      const conversation = data.conversations.get(conversationId);
      if (conversation) conversation.updatedAt = now();
      return clone(record);
    },
    async listMessages(conversationId, limit) {
      return data.messages.filter((m) => m.conversationId === conversationId).slice(-limit).map(clone);
    },
    async createTask(input) {
      const record: TaskRecord = {
        id: randomUUID(),
        conversationId: input.conversationId,
        userId: input.userId,
        status: TASK_STATUS.RECEIVED,
        plan: null,
        stepCount: 0,
        toolCallCount: 0,
        provider: input.provider,
        model: input.model,
        error: null,
        pending: null,
        createdAt: now(),
        updatedAt: now(),
        finishedAt: null,
      };
      data.tasks.set(record.id, record);
      return clone(record);
    },
    async getTask(id) {
      const task = data.tasks.get(id);
      return task ? clone(task) : null;
    },
    async getTaskForUser(userId, id) {
      const task = data.tasks.get(id);
      return task && task.userId === userId ? clone(task) : null;
    },
    async updateTask(id, patch) {
      const task = data.tasks.get(id);
      if (!task) throw new Error('task not found');
      Object.assign(task, patch, { updatedAt: now() });
      return clone(task);
    },
    async transitionTask(id, from, to, patch = {}) {
      const task = data.tasks.get(id);
      if (!task || !from.includes(task.status)) return false;
      Object.assign(task, patch, { status: to, updatedAt: now() });
      if (TERMINAL_STATUSES.has(to) && !task.finishedAt) task.finishedAt = now();
      return true;
    },
    async activeTaskForConversation(conversationId) {
      const task = [...data.tasks.values()].find((t) => t.conversationId === conversationId && !TERMINAL_STATUSES.has(t.status));
      return task ? clone(task) : null;
    },
    async listTasks(conversationId, limit) {
      return [...data.tasks.values()]
        .filter((t) => t.conversationId === conversationId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map(clone);
    },
    async failOrphans(olderThan) {
      let count = 0;
      for (const task of data.tasks.values()) {
        const running = [TASK_STATUS.RECEIVED, TASK_STATUS.ANALYZING, TASK_STATUS.EXECUTING, TASK_STATUS.VERIFYING] as string[];
        if (running.includes(task.status) && task.updatedAt < olderThan) {
          task.status = TASK_STATUS.FAILED;
          task.error = 'The task was interrupted by a server restart.';
          task.finishedAt = now();
          count += 1;
        }
      }
      return count;
    },
    async findExecution(taskId, toolCallId) {
      const record = data.executions.find((e) => e.taskId === taskId && e.toolCallId === toolCallId);
      return record ? clone(record) : null;
    },
    async saveExecution(input) {
      const existing = data.executions.find((e) => e.taskId === input.taskId && e.toolCallId === input.toolCallId);
      if (existing) {
        Object.assign(existing, input);
        return clone(existing);
      }
      const record: ExecutionRecord = { ...input, id: randomUUID(), createdAt: now() };
      data.executions.push(record);
      return clone(record);
    },
    async listExecutions(taskId) {
      return data.executions.filter((e) => e.taskId === taskId).map(clone);
    },
    async createConfirmation(input) {
      const record: ConfirmationRecord = { ...input, id: randomUUID(), status: 'PENDING', decidedAt: null, createdAt: now() };
      data.confirmations.set(record.id, record);
      return clone(record);
    },
    async getConfirmationForUser(userId, id) {
      const record = data.confirmations.get(id);
      return record && record.userId === userId ? clone(record) : null;
    },
    async consumeConfirmation(id, userId, at) {
      const record = data.confirmations.get(id);
      if (!record || record.userId !== userId || record.status !== 'PENDING' || record.expiresAt.getTime() <= at.getTime()) return null;
      record.status = 'CONSUMED';
      record.decidedAt = at;
      return clone(record);
    },
    async closeConfirmation(id, userId, status, at) {
      const record = data.confirmations.get(id);
      if (!record || record.userId !== userId || record.status !== 'PENDING') return false;
      record.status = status;
      record.decidedAt = at;
      return true;
    },
    async purgeExpired(conversationsBefore, usageBefore) {
      let removed = 0;
      for (const conversation of [...data.conversations.values()]) {
        if (conversation.updatedAt >= conversationsBefore) continue;
        const busy = [...data.tasks.values()].some((t) => t.conversationId === conversation.id && !TERMINAL_STATUSES.has(t.status));
        if (busy) continue;
        await this.deleteConversation(conversation.userId, conversation.id);
        removed += 1;
      }
      data.usage = data.usage.filter((u) => u.at >= usageBefore);
      return removed;
    },
    async recordUsage(entry) {
      data.usage.push({ userId: entry.userId, tokens: entry.inputTokens + entry.outputTokens, at: now() });
    },
    async tokensSince(userId, since) {
      return data.usage.filter((u) => u.userId === userId && u.at >= since).reduce((sum, u) => sum + u.tokens, 0);
    },
  };
}
