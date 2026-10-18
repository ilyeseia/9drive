/**
 * Risk policy and argument binding (docs/ai-agent-architecture.md §4.2).
 * Confirmation is a property of the tool definition and the validated arguments — the model
 * cannot lower it, skip it or approve it.
 */

import { createHash } from 'node:crypto';
import type { AnyTool } from './tools/types.js';

/** Stable JSON: object keys sorted recursively so equal arguments always hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function hashArgs(toolName: string, args: unknown): string {
  return createHash('sha256').update(`${toolName}\n${canonicalJson(args)}`).digest('hex');
}

/** `true` when this exact (validated) call must be approved by the user before it runs. */
export function requiresConfirmation(tool: AnyTool, validatedArgs: unknown): boolean {
  if (tool.needsConfirmation) return tool.needsConfirmation(validatedArgs as never);
  return tool.risk !== 'low';
}

export const CONFIRMATION_STATUS = {
  PENDING: 'PENDING',
  CONSUMED: 'CONSUMED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
} as const;
