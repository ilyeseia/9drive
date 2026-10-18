/** Prisma-backed AgentStore. Every read that crosses a trust boundary is `userId`-scoped. */

import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import type { ToolCall } from './providers/types.js';
import {
  TASK_STATUS,
  TERMINAL_STATUSES,
  type AgentStore,
  type ConfirmationRecord,
  type ConversationRecord,
  type ExecutionRecord,
  type MessageRecord,
  type TaskRecord,
  type TaskStatus,
} from './store.js';

function toMessage(row: {
  id: string;
  conversationId: string;
  seq: number;
  role: string;
  content: string;
  toolCalls: Prisma.JsonValue | null;
  toolCallId: string | null;
  taskId: string | null;
  createdAt: Date;
}): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    role: row.role as MessageRecord['role'],
    content: row.content,
    toolCalls: Array.isArray(row.toolCalls) ? (row.toolCalls as unknown as ToolCall[]) : null,
    toolCallId: row.toolCallId,
    taskId: row.taskId,
    createdAt: row.createdAt,
  };
}

function toTask(row: {
  id: string;
  conversationId: string;
  userId: string;
  status: string;
  plan: string | null;
  stepCount: number;
  toolCallCount: number;
  provider: string | null;
  model: string | null;
  error: string | null;
  pending: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}): TaskRecord {
  const pending =
    row.pending && typeof row.pending === 'object' && !Array.isArray(row.pending)
      ? (row.pending as { confirmationId?: unknown; toolCallId?: unknown })
      : null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    userId: row.userId,
    status: row.status as TaskStatus,
    plan: row.plan,
    stepCount: row.stepCount,
    toolCallCount: row.toolCallCount,
    provider: row.provider,
    model: row.model,
    error: row.error,
    pending:
      pending && typeof pending.confirmationId === 'string' && typeof pending.toolCallId === 'string'
        ? { confirmationId: pending.confirmationId, toolCallId: pending.toolCallId }
        : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  };
}

function toExecution(row: {
  id: string;
  taskId: string;
  userId: string;
  toolName: string;
  toolCallId: string;
  args: Prisma.JsonValue;
  status: string;
  summary: string | null;
  verification: string | null;
  userOutput: Prisma.JsonValue | null;
  errorCode: string | null;
  confirmationId: string | null;
  latencyMs: number | null;
  createdAt: Date;
}): ExecutionRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    userId: row.userId,
    toolName: row.toolName,
    toolCallId: row.toolCallId,
    args: row.args,
    status: row.status as ExecutionRecord['status'],
    summary: row.summary,
    verification: row.verification,
    userOutput: row.userOutput && typeof row.userOutput === 'object' && !Array.isArray(row.userOutput) ? (row.userOutput as Record<string, unknown>) : null,
    errorCode: row.errorCode,
    confirmationId: row.confirmationId,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt,
  };
}

function toConfirmation(row: {
  id: string;
  userId: string;
  taskId: string;
  toolName: string;
  toolCallId: string;
  args: Prisma.JsonValue;
  argsHash: string;
  summary: string;
  preview: Prisma.JsonValue | null;
  risk: string;
  status: string;
  expiresAt: Date;
  decidedAt: Date | null;
  createdAt: Date;
}): ConfirmationRecord {
  return {
    id: row.id,
    userId: row.userId,
    taskId: row.taskId,
    toolName: row.toolName,
    toolCallId: row.toolCallId,
    args: row.args,
    argsHash: row.argsHash,
    summary: row.summary,
    preview: row.preview,
    risk: row.risk as ConfirmationRecord['risk'],
    status: row.status as ConfirmationRecord['status'],
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

const NON_TERMINAL: TaskStatus[] = [
  TASK_STATUS.RECEIVED,
  TASK_STATUS.ANALYZING,
  TASK_STATUS.AWAITING_CONFIRMATION,
  TASK_STATUS.EXECUTING,
  TASK_STATUS.VERIFYING,
];

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;

export function createPrismaStore(): AgentStore {
  return {
    async createConversation(userId, locale, title) {
      return prisma.aiConversation.create({ data: { userId, locale, title } });
    },
    async getConversation(userId, id) {
      return prisma.aiConversation.findFirst({ where: { id, userId } }) as Promise<ConversationRecord | null>;
    },
    async listConversations(userId, limit) {
      return prisma.aiConversation.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' }, take: limit });
    },
    async deleteConversation(userId, id) {
      const result = await prisma.aiConversation.deleteMany({ where: { id, userId } });
      return result.count > 0;
    },
    async updateConversation(id, patch) {
      await prisma.aiConversation.update({ where: { id }, data: patch });
    },
    async appendMessage(conversationId, input) {
      // `seq` is allocated under the (conversationId, seq) unique index; one active task per
      // conversation makes contention rare, and a clash simply retries with the next number.
      for (let attempt = 0; attempt < 5; attempt++) {
        const last = await prisma.aiMessage.findFirst({ where: { conversationId }, orderBy: { seq: 'desc' }, select: { seq: true } });
        try {
          const row = await prisma.aiMessage.create({
            data: {
              conversationId,
              seq: (last?.seq ?? 0) + 1,
              role: input.role,
              content: input.content,
              toolCalls: input.toolCalls ? json(input.toolCalls) : Prisma.DbNull,
              toolCallId: input.toolCallId ?? null,
              taskId: input.taskId ?? null,
            },
          });
          await prisma.aiConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }).catch(() => undefined);
          return toMessage(row);
        } catch (error) {
          if ((error as { code?: string }).code !== 'P2002' || attempt === 4) throw error;
        }
      }
      throw new Error('unreachable');
    },
    async listMessages(conversationId, limit) {
      const rows = await prisma.aiMessage.findMany({ where: { conversationId }, orderBy: { seq: 'desc' }, take: limit });
      return rows.reverse().map(toMessage);
    },
    async createTask(input) {
      return toTask(await prisma.aiTask.create({ data: { ...input, status: TASK_STATUS.RECEIVED } }));
    },
    async getTask(id) {
      const row = await prisma.aiTask.findUnique({ where: { id } });
      return row ? toTask(row) : null;
    },
    async getTaskForUser(userId, id) {
      const row = await prisma.aiTask.findFirst({ where: { id, userId } });
      return row ? toTask(row) : null;
    },
    async updateTask(id, patch) {
      const { pending, ...rest } = patch;
      return toTask(
        await prisma.aiTask.update({
          where: { id },
          data: { ...rest, ...(pending !== undefined ? { pending: pending === null ? Prisma.DbNull : json(pending) } : {}) },
        }),
      );
    },
    async transitionTask(id, from, to, patch = {}) {
      const { pending, ...rest } = patch;
      const result = await prisma.aiTask.updateMany({
        where: { id, status: { in: from } },
        data: {
          ...rest,
          status: to,
          ...(pending !== undefined ? { pending: pending === null ? Prisma.DbNull : json(pending) } : {}),
          ...(TERMINAL_STATUSES.has(to) && rest.finishedAt === undefined ? { finishedAt: new Date() } : {}),
        },
      });
      return result.count > 0;
    },
    async activeTaskForConversation(conversationId) {
      const row = await prisma.aiTask.findFirst({ where: { conversationId, status: { in: NON_TERMINAL } }, orderBy: { createdAt: 'desc' } });
      return row ? toTask(row) : null;
    },
    async listTasks(conversationId, limit) {
      const rows = await prisma.aiTask.findMany({ where: { conversationId }, orderBy: { createdAt: 'desc' }, take: limit });
      return rows.map(toTask);
    },
    async failOrphans(olderThan) {
      const result = await prisma.aiTask.updateMany({
        where: {
          status: { in: [TASK_STATUS.RECEIVED, TASK_STATUS.ANALYZING, TASK_STATUS.EXECUTING, TASK_STATUS.VERIFYING] },
          updatedAt: { lt: olderThan },
        },
        data: { status: TASK_STATUS.FAILED, error: 'The task was interrupted by a server restart.', finishedAt: new Date() },
      });
      return result.count;
    },
    async findExecution(taskId, toolCallId) {
      const row = await prisma.aiToolExecution.findUnique({ where: { taskId_toolCallId: { taskId, toolCallId } } });
      return row ? toExecution(row) : null;
    },
    async saveExecution(input) {
      const data = {
        userId: input.userId,
        toolName: input.toolName,
        args: json(input.args),
        status: input.status,
        summary: input.summary,
        verification: input.verification,
        userOutput: input.userOutput ? json(input.userOutput) : Prisma.DbNull,
        errorCode: input.errorCode,
        confirmationId: input.confirmationId,
        latencyMs: input.latencyMs,
      };
      return toExecution(
        await prisma.aiToolExecution.upsert({
          where: { taskId_toolCallId: { taskId: input.taskId, toolCallId: input.toolCallId } },
          create: { taskId: input.taskId, toolCallId: input.toolCallId, ...data },
          update: data,
        }),
      );
    },
    async listExecutions(taskId) {
      const rows = await prisma.aiToolExecution.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });
      return rows.map(toExecution);
    },
    async createConfirmation(input) {
      return toConfirmation(
        await prisma.aiActionConfirmation.create({
          data: {
            userId: input.userId,
            taskId: input.taskId,
            toolName: input.toolName,
            toolCallId: input.toolCallId,
            args: json(input.args),
            argsHash: input.argsHash,
            summary: input.summary,
            preview: json(input.preview),
            risk: input.risk,
            status: 'PENDING',
            expiresAt: input.expiresAt,
          },
        }),
      );
    },
    async getConfirmationForUser(userId, id) {
      const row = await prisma.aiActionConfirmation.findFirst({ where: { id, userId } });
      return row ? toConfirmation(row) : null;
    },
    async consumeConfirmation(id, userId, now) {
      // Single conditional UPDATE: the winner of a race (or a replay) is decided by the database.
      const result = await prisma.aiActionConfirmation.updateMany({
        where: { id, userId, status: 'PENDING', expiresAt: { gt: now } },
        data: { status: 'CONSUMED', decidedAt: now },
      });
      if (result.count === 0) return null;
      const row = await prisma.aiActionConfirmation.findFirst({ where: { id, userId } });
      return row ? toConfirmation(row) : null;
    },
    async closeConfirmation(id, userId, status, now) {
      const result = await prisma.aiActionConfirmation.updateMany({
        where: { id, userId, status: 'PENDING' },
        data: { status, decidedAt: now },
      });
      return result.count > 0;
    },
    async recordUsage(entry) {
      await prisma.aiUsageRecord.create({ data: entry });
    },
    async tokensSince(userId, since) {
      const sum = await prisma.aiUsageRecord.aggregate({
        where: { userId, createdAt: { gte: since } },
        _sum: { inputTokens: true, outputTokens: true },
      });
      return (sum._sum.inputTokens ?? 0) + (sum._sum.outputTokens ?? 0);
    },
  };
}
