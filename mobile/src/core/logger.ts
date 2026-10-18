/**
 * Logger that cannot leak secrets by construction.
 *
 * Everything passes through `redact`, which masks bearer tokens, JWT-shaped strings, `token=`/`key=`-style
 * query parameters, signed-URL signatures and any object key that looks sensitive. Callers should still avoid
 * logging request/response bodies; this is the safety net, not the policy.
 *
 * Release builds only emit `warn` and `error`. A sink can be attached for crash reporting; it receives the
 * already-redacted event.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

const SENSITIVE_KEY = /(authorization|password|passwd|secret|token|api[-_]?key|cookie|signature|credential|refresh)/i;

const PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]'],
  [
    /([?&](?:token|access_token|refresh_token|key|apikey|api_key|signature|sig|x-amz-signature|x-goog-signature|password)=)[^&\s]+/gi,
    '$1[redacted]',
  ],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted-key]'],
];

const MAX_STRING = 500;
const MAX_DEPTH = 4;

export function redactString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redact(entry, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(entry, depth + 1);
    }
    return out;
  }
  return '[unserializable]';
}

type Sink = (event: LogEvent) => void;

let sink: Sink | null = null;
let verbose = typeof __DEV__ !== 'undefined' ? __DEV__ : false;

export function setLogSink(next: Sink | null): void {
  sink = next;
}

export function setVerbose(value: boolean): void {
  verbose = value;
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (!verbose && (level === 'debug' || level === 'info')) return;
  const event: LogEvent = {
    level,
    message: redactString(message),
    ...(context ? { context: redact(context) as Record<string, unknown> } : {}),
  };
  sink?.(event);
  const line = event.context ? [event.message, event.context] : [event.message];
  if (level === 'error') console.error(...line);
  else if (level === 'warn') console.warn(...line);
  else console.log(...line);
}

export const log = {
  debug: (message: string, context?: Record<string, unknown>) => emit('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => emit('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => emit('error', message, context),
};
