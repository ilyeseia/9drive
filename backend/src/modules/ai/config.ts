/**
 * AI assistant configuration (docs/ai-agent-architecture.md §5).
 *
 * Read from the environment, validated once, and reported with an explicit reason when the
 * assistant is disabled. The API key never leaves the backend. Nothing here falls back to a
 * different provider or model: a missing or invalid setting disables the assistant.
 */

export const AI_PROVIDER_IDS = ['openai_compatible', 'anthropic'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export interface AiConfig {
  enabled: boolean;
  /** Human-readable reason when `enabled` is false (safe to show to users). */
  reason: string | null;
  provider: AiProviderId | null;
  model: string | null;
  apiKey: string | null;
  baseUrl: string | null;
  requestTimeoutMs: number;
  maxOutputTokens: number;
  maxRetries: number;
  maxSteps: number;
  maxToolCalls: number;
  taskTimeoutMs: number;
  maxConcurrentTasksPerUser: number;
  maxConcurrentTasks: number;
  dailyTokenLimit: number | null;
  confirmationTtlSeconds: number;
  historyMaxMessages: number;
  /** Largest batch (files) any tool accepts. */
  maxBatch: number;
  /** Hard cap on rows a read tool returns. */
  maxResults: number;
  /** Conversations untouched for this many days are deleted automatically. */
  retentionDays: number;
}

type Env = Record<string, string | undefined>;

function intIn(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function optionalInt(env: Env, name: string, min: number, max: number): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export function loadAiConfig(env: Env = process.env): AiConfig {
  const base: AiConfig = {
    enabled: false,
    reason: null,
    provider: null,
    model: null,
    apiKey: null,
    baseUrl: null,
    requestTimeoutMs: intIn(env, 'AI_REQUEST_TIMEOUT_MS', 60_000, 1_000, 600_000),
    maxOutputTokens: intIn(env, 'AI_MAX_OUTPUT_TOKENS', 1_500, 64, 32_000),
    maxRetries: intIn(env, 'AI_MAX_RETRIES', 2, 0, 5),
    maxSteps: intIn(env, 'AI_MAX_STEPS', 8, 1, 30),
    maxToolCalls: intIn(env, 'AI_MAX_TOOL_CALLS', 12, 1, 100),
    taskTimeoutMs: intIn(env, 'AI_TASK_TIMEOUT_MS', 180_000, 5_000, 1_800_000),
    maxConcurrentTasksPerUser: intIn(env, 'AI_MAX_CONCURRENT_TASKS_PER_USER', 2, 1, 10),
    maxConcurrentTasks: intIn(env, 'AI_MAX_CONCURRENT_TASKS', 20, 1, 500),
    dailyTokenLimit: optionalInt(env, 'AI_DAILY_TOKEN_LIMIT', 1_000, 1_000_000_000),
    confirmationTtlSeconds: intIn(env, 'AI_CONFIRMATION_TTL_SECONDS', 300, 30, 3_600),
    historyMaxMessages: intIn(env, 'AI_HISTORY_MAX_MESSAGES', 30, 4, 200),
    maxBatch: intIn(env, 'AI_MAX_BATCH', 100, 1, 500),
    maxResults: intIn(env, 'AI_MAX_RESULTS', 50, 5, 200),
    retentionDays: intIn(env, 'AI_RETENTION_DAYS', 90, 1, 3650),
  };

  const provider = env.AI_PROVIDER?.trim();
  if (!provider) return { ...base, reason: 'The AI assistant is not configured (AI_PROVIDER is not set).' };
  if (!(AI_PROVIDER_IDS as readonly string[]).includes(provider)) {
    return {
      ...base,
      reason: `AI_PROVIDER "${provider.slice(0, 40)}" is not supported. Use one of: ${AI_PROVIDER_IDS.join(', ')}.`,
    };
  }
  const model = env.AI_MODEL?.trim();
  if (!model) return { ...base, provider: provider as AiProviderId, reason: 'AI_MODEL is not set.' };

  const baseUrlRaw = env.AI_BASE_URL?.trim() || null;
  if (baseUrlRaw) {
    try {
      const url = new URL(baseUrlRaw);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
      if (url.username || url.password) throw new Error('credentials');
    } catch {
      return { ...base, provider: provider as AiProviderId, model, reason: 'AI_BASE_URL is not a valid http(s) URL.' };
    }
  }

  const apiKey = env.AI_API_KEY?.trim() || null;
  // Self-hosted OpenAI-compatible servers (Ollama, vLLM, LM Studio) commonly need no key;
  // the hosted defaults always do.
  const keyOptional = provider === 'openai_compatible' && baseUrlRaw !== null;
  if (!apiKey && !keyOptional) {
    return { ...base, provider: provider as AiProviderId, model, reason: 'AI_API_KEY is not set.' };
  }

  return {
    ...base,
    enabled: true,
    provider: provider as AiProviderId,
    model,
    apiKey,
    baseUrl: baseUrlRaw ? baseUrlRaw.replace(/\/+$/, '') : null,
  };
}

/** Safe to return to any authenticated user: no secret and no endpoint. */
export function publicAiStatus(config: AiConfig): {
  enabled: boolean;
  reason: string | null;
  provider: AiProviderId | null;
  model: string | null;
  limits: { maxSteps: number; maxToolCalls: number; confirmationTtlSeconds: number; dailyTokenLimit: number | null };
} {
  return {
    enabled: config.enabled,
    reason: config.reason,
    provider: config.provider,
    model: config.model,
    limits: {
      maxSteps: config.maxSteps,
      maxToolCalls: config.maxToolCalls,
      confirmationTtlSeconds: config.confirmationTtlSeconds,
      dailyTokenLimit: config.dailyTokenLimit,
    },
  };
}

let cached: AiConfig | null = null;

export function getAiConfig(): AiConfig {
  cached ??= loadAiConfig();
  return cached;
}

/** Test seam. */
export function resetAiConfigCache(next: AiConfig | null = null): void {
  cached = next;
}
