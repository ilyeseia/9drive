/**
 * Model-provider abstraction. The orchestrator only knows these types; each vendor adapter maps
 * them to its wire format. Tool arguments are always parsed JSON (never executable text).
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments; `undefined` when the model produced invalid JSON (see `rawArguments`). */
  arguments: unknown;
  rawArguments: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object). */
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: ModelUsage | null;
  stopReason: 'end' | 'tool_use' | 'length' | 'other';
}

export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export type ModelErrorCode =
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_TIMEOUT'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_BAD_RESPONSE'
  | 'MODEL_BAD_REQUEST'
  | 'MODEL_AUTH'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_NO_TOOLS'
  | 'MODEL_CANCELLED';

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(code: ModelErrorCode, message: string, opts: { retryable?: boolean; retryAfterMs?: number | null } = {}) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }

  static is(error: unknown): error is ModelError {
    return error instanceof ModelError;
  }
}
