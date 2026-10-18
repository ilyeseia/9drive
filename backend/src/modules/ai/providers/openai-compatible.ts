/**
 * Adapter for any server implementing OpenAI's `/chat/completions` with `tools`
 * (OpenAI, Gemini's OpenAI-compatible endpoint, OpenRouter, Ollama, vLLM, LM Studio, …).
 */

import { postJson } from './http.js';
import {
  ModelError,
  type ChatMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ToolCall,
} from './types.js';

export interface OpenAiCompatibleOptions {
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
  timeoutMs: number;
  maxRetries: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function toWireMessages(system: string, messages: ChatMessage[]): unknown[] {
  const wire: unknown[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'tool') {
      wire.push({ role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content });
    } else if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      wire.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.rawArguments || JSON.stringify(call.arguments ?? {}) },
        })),
      });
    } else {
      wire.push({ role: message.role, content: message.content });
    }
  }
  return wire;
}

function parseArguments(raw: unknown): { parsed: unknown; raw: string } {
  const text = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '{}' : JSON.stringify(raw);
  if (text.trim() === '') return { parsed: {}, raw: '{}' };
  try {
    return { parsed: JSON.parse(text), raw: text };
  } catch {
    return { parsed: undefined, raw: text.slice(0, 2000) };
  }
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id = 'openai_compatible';
  readonly model: string;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.model = options.model;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const base = (this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const hosted = new URL(base).hostname === 'api.openai.com';
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: toWireMessages(request.system, request.messages),
      // OpenAI's newer models reject `max_tokens`; most compatible servers only know it.
      [hosted ? 'max_completion_tokens' : 'max_tokens']: request.maxOutputTokens,
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      body.tool_choice = 'auto';
    }
    const payload = await postJson({
      url: `${base}/chat/completions`,
      headers: this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {},
      body,
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      signal: request.signal,
      sleep: this.options.sleep,
    });
    return parseResponse(payload);
  }
}

/** Text of a message: a plain string, or an array of content parts (some gateways), minus reasoning blocks. */
function messageText(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((part) => (typeof part === 'string' ? part : part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('');
  }
  // Reasoning models behind gateways sometimes inline their chain of thought; it is not an answer.
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

export function parseResponse(payload: unknown): ModelResponse {
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0 || typeof choices[0] !== 'object' || choices[0] === null) {
    throw new ModelError('MODEL_BAD_RESPONSE', 'The model response had no choices.');
  }
  const choice = choices[0] as { message?: Record<string, unknown>; finish_reason?: unknown };
  const message = choice.message;
  if (!message || typeof message !== 'object') throw new ModelError('MODEL_BAD_RESPONSE', 'The model response had no message.');

  const toolCalls: ToolCall[] = [];
  const rawCalls = message.tool_calls;
  if (Array.isArray(rawCalls)) {
    rawCalls.forEach((entry, index) => {
      const call = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const name = call?.function?.name;
      if (typeof name !== 'string' || name === '') throw new ModelError('MODEL_BAD_RESPONSE', 'A tool call had no name.');
      const { parsed, raw } = parseArguments(call.function?.arguments);
      toolCalls.push({
        id: typeof call.id === 'string' && call.id !== '' ? call.id.slice(0, 128) : `call_${index}`,
        name,
        arguments: parsed,
        rawArguments: raw,
      });
    });
  }

  const usage = (payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  const finish = choice.finish_reason;
  return {
    text: messageText(message.content),
    toolCalls,
    usage:
      usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number'
        ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
        : null,
    stopReason: toolCalls.length > 0 ? 'tool_use' : finish === 'length' ? 'length' : finish === 'stop' ? 'end' : 'other',
  };
}
