/** Adapter for Anthropic's native Messages API with `tool_use` / `tool_result` blocks. */

import { postJson } from './http.js';
import {
  ModelError,
  type ChatMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ToolCall,
} from './types.js';

export interface AnthropicOptions {
  model: string;
  apiKey: string;
  baseUrl: string | null;
  timeoutMs: number;
  maxRetries: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

type Block = Record<string, unknown>;

function toWireMessages(messages: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: string | Block[] }> {
  const wire: Array<{ role: 'user' | 'assistant'; content: string | Block[] }> = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const block: Block = { type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content };
      const last = wire[wire.length - 1];
      // Consecutive tool results must live in one user turn.
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        wire.push({ role: 'user', content: [block] });
      }
    } else if (message.role === 'assistant') {
      const blocks: Block[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} });
      }
      wire.push({ role: 'assistant', content: blocks.length > 0 ? blocks : message.content || '(no content)' });
    } else {
      wire.push({ role: 'user', content: message.content });
    }
  }
  return wire;
}

export function parseAnthropicResponse(payload: unknown): ModelResponse {
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new ModelError('MODEL_BAD_RESPONSE', 'The model response had no content.');
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const entry of content) {
    const block = entry as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    if (block.type === 'tool_use') {
      if (typeof block.name !== 'string' || block.name === '') throw new ModelError('MODEL_BAD_RESPONSE', 'A tool call had no name.');
      const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : undefined;
      toolCalls.push({
        id: typeof block.id === 'string' && block.id !== '' ? block.id.slice(0, 128) : `call_${toolCalls.length}`,
        name: block.name,
        arguments: input,
        rawArguments: input === undefined ? '' : JSON.stringify(input),
      });
    }
  }
  const usage = (payload as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
  const stop = (payload as { stop_reason?: unknown }).stop_reason;
  return {
    text,
    toolCalls,
    usage:
      usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
        ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
        : null,
    stopReason: toolCalls.length > 0 ? 'tool_use' : stop === 'max_tokens' ? 'length' : stop === 'end_turn' ? 'end' : 'other',
  };
}

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';
  readonly model: string;

  constructor(private readonly options: AnthropicOptions) {
    this.model = options.model;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const base = (this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const body: Record<string, unknown> = {
      model: this.options.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: toWireMessages(request.messages),
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    const payload = await postJson({
      url: `${base}/v1/messages`,
      headers: { 'x-api-key': this.options.apiKey, 'anthropic-version': API_VERSION },
      body,
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      signal: request.signal,
      sleep: this.options.sleep,
    });
    return parseAnthropicResponse(payload);
  }
}
