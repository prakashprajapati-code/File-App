export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_ROLES = ["tv", "phone", "server", "unknown"] as const;

export type LogRole = (typeof LOG_ROLES)[number];

/** A JSON-safe value. Everything the logger stores is passed through `redact`. */
export type LogValue = string | number | boolean | null | LogValue[] | { [key: string]: LogValue };

export interface LogEntry {
  /** Monotonic per page load. */
  seq: number;
  /** Epoch milliseconds. */
  ts: number;
  /** Milliseconds since the logger module loaded. */
  tPlus: number;
  level: LogLevel;
  scope: string;
  event: string;
  sessionId: string;
  role: LogRole;
  data?: LogValue;
}

export const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
