/**
 * Typed tool registry. Every execution passes through `runTool`, which validates the arguments,
 * enforces the timeout, normalises errors, validates the output contract and scrubs the result.
 * Authorization is performed by the tools themselves with `ctx.userId` (userId-scoped queries);
 * nothing here trusts model-supplied identifiers.
 */

import { z } from 'zod';
import { ProviderError } from '../../../providers/errors.js';
import { scrubValue } from '../sanitize.js';
import type { ToolSpec } from '../providers/types.js';
import { ToolError, type AnyTool, type ToolContext, type ToolResult } from './types.js';

export type ToolOutcome =
  | { ok: true; result: ToolResult }
  | { ok: false; code: string; message: string };

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(tool: AnyTool): this {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(tool.name)) throw new Error(`invalid tool name: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AnyTool | null {
    return this.tools.get(name) ?? null;
  }

  all(): AnyTool[] {
    return [...this.tools.values()];
  }

  /** Model-facing definitions (JSON Schema derived from the Zod input schema). */
  specs(filter?: (tool: AnyTool) => boolean): ToolSpec[] {
    return this.all()
      .filter((tool) => (filter ? filter(tool) : true))
      .map((tool) => {
        const schema = z.toJSONSchema(tool.input, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
        delete schema.$schema;
        return { name: tool.name, description: `${tool.description} [risk: ${tool.risk}]`, parameters: schema };
      });
  }
}

function issuesToMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ')
    .slice(0, 400);
}

export function parseToolArgs(tool: AnyTool, rawArgs: unknown): { ok: true; args: unknown } | { ok: false; message: string } {
  if (rawArgs === undefined) return { ok: false, message: 'The tool arguments were not valid JSON.' };
  const parsed = tool.input.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, message: issuesToMessage(parsed.error) };
  return { ok: true, args: parsed.data };
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolError('PROVIDER_ERROR', 'The operation timed out.')), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ToolError('PROVIDER_ERROR', 'The operation was cancelled.'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function normaliseError(error: unknown): { code: string; message: string } {
  if (error instanceof ToolError) return { code: error.code, message: error.message };
  if (ProviderError.is(error)) {
    // Provider messages are fixed strings (no credentials) but never echo `detail`.
    return { code: 'PROVIDER_ERROR', message: `The storage provider reported ${error.code}: ${error.message}`.slice(0, 300) };
  }
  const prismaCode = (error as { code?: unknown } | null)?.code;
  if (prismaCode === 'P2025') return { code: 'NOT_FOUND', message: 'The requested item was not found.' };
  console.error('[ai] tool failed unexpectedly', error instanceof Error ? error.message : 'unknown');
  return { code: 'INTERNAL', message: 'The tool failed unexpectedly.' };
}

/** Executes an already-authorised, already-validated call. Never throws. */
export async function runTool(tool: AnyTool, validatedArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    const result = await withTimeout(tool.execute(validatedArgs, ctx), tool.timeoutMs, ctx.signal);
    const scrubbed = scrubValue(result.data);
    const checked = tool.output.safeParse(scrubbed);
    if (!checked.success) {
      console.error(`[ai] tool ${tool.name} produced output violating its contract`);
      return { ok: false, code: 'INTERNAL', message: 'The tool produced an invalid result.' };
    }
    return { ok: true, result: { ...result, data: scrubbed } };
  } catch (error) {
    const { code, message } = normaliseError(error);
    return { ok: false, code, message };
  }
}
