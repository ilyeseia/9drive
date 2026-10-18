import type { z } from 'zod';
import type { AiConfig } from '../config.js';

export type Risk = 'low' | 'medium' | 'high';

export type ToolDomain = 'accounts' | 'files' | 'routing' | 'sharing' | 'reports' | 'system';

export interface ToolContext {
  /** Authenticated user; always comes from the session, never from model output. */
  userId: string;
  taskId: string;
  config: AiConfig;
  signal?: AbortSignal;
  now: () => Date;
}

export interface ToolResult {
  /** JSON-safe data for the model (scrubbed + wrapped as untrusted by the orchestrator). */
  data: unknown;
  /** One-line, user-visible statement of what was actually done / retrieved. */
  summary: string;
  /** What was re-read after a state change to confirm the outcome. Absent for reads. */
  verification?: string;
  /** `true` when only part of the requested work succeeded. */
  partial?: boolean;
  /** Shown to the user only; never sent to the model (e.g. a freshly created share URL). */
  userOutput?: Record<string, unknown>;
}

/** Server-generated preview shown on a confirmation card (derived from real data, not from the model). */
export interface ConfirmationPreview {
  /** Plain statement of the action in the user's own terms. */
  summary: string;
  affectedCount: number;
  sample: string[];
  warnings: string[];
}

export interface ToolDefinition<I extends z.ZodType = z.ZodType> {
  name: string;
  domain: ToolDomain;
  description: string;
  input: I;
  /** Loose output contract; a result that violates it fails closed. */
  output: z.ZodType;
  risk: Risk;
  /** Overrides the default (`risk !== 'low'`) for a specific call. */
  needsConfirmation?: (args: z.output<I>) => boolean;
  timeoutMs: number;
  /** Mutations write an AuditLog row from inside `execute`. */
  audit: boolean;
  /** Dry-run description for the confirmation card. Must not mutate anything. */
  preview?: (args: z.output<I>, ctx: ToolContext) => Promise<ConfirmationPreview>;
  execute: (args: z.output<I>, ctx: ToolContext) => Promise<ToolResult>;
}

export type AnyTool = ToolDefinition<z.ZodType>;

/** Typed expected failure that tools raise; surfaced to the model as a normalised error. */
export class ToolError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_ARGUMENTS' | 'UNSUPPORTED' | 'FORBIDDEN' | 'CONFLICT' | 'PROVIDER_ERROR' | 'LIMIT_EXCEEDED',
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Keeps each tool's argument types precise while storing it in the heterogeneous registry. */
export function defineTool<I extends z.ZodType>(tool: ToolDefinition<I>): AnyTool {
  return tool as unknown as AnyTool;
}
