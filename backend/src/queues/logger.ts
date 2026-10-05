import { serializeBigInt } from '../utils/serialize.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function minLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel
  return LEVEL_ORDER[raw] ?? LEVEL_ORDER.info
}

function write(
  level: LogLevel,
  message: string,
  bindings: Record<string, unknown>,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < minLevel()) return
  const record = { time: new Date().toISOString(), level, msg: message, ...bindings, ...fields }
  const line = JSON.stringify(serializeBigInt(record))
  if (level === 'warn' || level === 'error') console.error(line)
  else console.log(line)
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (message, fields) => write('debug', message, bindings, fields),
    info: (message, fields) => write('info', message, bindings, fields),
    warn: (message, fields) => write('warn', message, bindings, fields),
    error: (message, fields) => write('error', message, bindings, fields),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  }
}

export const logger = createLogger()
