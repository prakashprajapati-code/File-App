import { LEVEL_RANK, LOG_LEVELS } from "./types";
import type { LogEntry, LogLevel, LogRole } from "./types";
import { redact } from "./redact";

export const MAX_LOG_ENTRIES = 400;

const STORAGE_KEY = "ft:logs:v1";
const PERSIST_DELAY_MS = 400;
const EMPTY_ENTRIES: LogEntry[] = [];

interface LogState {
  entries: LogEntry[];
  seq: number;
  level: LogLevel;
  sessionId: string;
  startedAt: number;
  listeners: Set<() => void>;
  restored: boolean;
  persistTimer: ReturnType<typeof setTimeout> | null;
}

const state: LogState = {
  entries: EMPTY_ENTRIES,
  seq: 0,
  level: "info",
  sessionId: "",
  startedAt: Date.now(),
  listeners: new Set(),
  restored: false,
  persistTimer: null,
};

export interface Logger {
  readonly scope: string;
  debug(event: string, data?: unknown): void;
  info(event: string, data?: unknown): void;
  warn(event: string, data?: unknown): void;
  error(event: string, data?: unknown): void;
  /** Records a named stage so the log reads as a timeline. */
  mark(stage: string, data?: unknown): void;
  child(scope: string): Logger;
  time(event: string): (data?: unknown) => void;
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function randomId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
}

function getSessionId(): string {
  if (!state.sessionId) state.sessionId = randomId();
  return state.sessionId;
}

function readStorage(key: string): string | null {
  if (!isBrowser()) return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Storage can be full or disabled (private mode). Logging must not throw.
  }
}

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

function isLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.seq === "number" &&
    typeof entry.ts === "number" &&
    typeof entry.tPlus === "number" &&
    isLogLevel(entry.level) &&
    typeof entry.scope === "string" &&
    typeof entry.event === "string" &&
    typeof entry.sessionId === "string" &&
    typeof entry.role === "string"
  );
}

function configuredLevel(): LogLevel {
  if (isBrowser()) {
    try {
      if (new URLSearchParams(window.location.search).get("debug") === "1") return "debug";
    } catch {
      // Ignore malformed locations.
    }
  }

  const fromEnv = process.env.NEXT_PUBLIC_LOG_LEVEL;
  if (isLogLevel(fromEnv)) return fromEnv;

  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

state.level = configuredLevel();

function restore(): void {
  if (state.restored) return;
  state.restored = true;

  const raw = readStorage(STORAGE_KEY);
  if (!raw) return;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;

    const entries = parsed.filter(isLogEntry).slice(-MAX_LOG_ENTRIES);
    if (entries.length === 0) return;

    state.entries = entries;
    state.seq = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
    state.sessionId = entries[entries.length - 1]?.sessionId ?? state.sessionId;
  } catch {
    // A corrupt buffer is not worth failing over.
  }
}

function persistNow(): void {
  if (!isBrowser()) return;
  try {
    writeStorage(STORAGE_KEY, JSON.stringify(state.entries));
  } catch {
    // Serialisation can fail on exotic values; logging must stay append-only.
  }
}

function schedulePersist(): void {
  if (!isBrowser() || state.persistTimer) return;
  state.persistTimer = setTimeout(() => {
    state.persistTimer = null;
    persistNow();
  }, PERSIST_DELAY_MS);
}

function emit(): void {
  for (const listener of state.listeners) listener();
}

function mirror(entry: LogEntry): void {
  const prefix = `[ft:${entry.role}/${entry.scope}] +${(entry.tPlus / 1000).toFixed(2)}s ${entry.event}`;
  const payload = entry.data ?? "";

  switch (entry.level) {
    case "debug":
      console.debug(prefix, payload);
      break;
    case "info":
      console.info(prefix, payload);
      break;
    case "warn":
      console.warn(prefix, payload);
      break;
    case "error":
      console.warn(prefix, payload);
      break;
  }
}

function push(level: LogLevel, role: LogRole, scope: string, event: string, data?: unknown): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[state.level]) return;

  restore();

  const now = Date.now();
  const entry: LogEntry = {
    seq: state.seq + 1,
    ts: now,
    tPlus: now - state.startedAt,
    level,
    scope,
    event,
    sessionId: getSessionId(),
    role,
  };

  if (data !== undefined) entry.data = redact(data);

  state.seq = entry.seq;
  state.entries = [...state.entries, entry].slice(-MAX_LOG_ENTRIES);

  mirror(entry);
  schedulePersist();
  emit();
}

export function createLogger(scope: string, role: LogRole = "unknown"): Logger {
  const logger: Logger = {
    scope,
    debug: (event, data) => push("debug", role, scope, event, data),
    info: (event, data) => push("info", role, scope, event, data),
    warn: (event, data) => push("warn", role, scope, event, data),
    error: (event, data) => push("error", role, scope, event, data),
    mark: (stage, data) => push("info", role, scope, `stage:${stage}`, data),
    child: (childScope) => createLogger(`${scope}:${childScope}`, role),
    time: (event) => {
      const startedAt = Date.now();
      return (data?: unknown) => push("debug", role, scope, `${event}:done`, { ms: Date.now() - startedAt, detail: data });
    },
  };

  return logger;
}

export function setLogLevel(level: LogLevel): void {
  state.level = level;
}

export function getLogLevel(): LogLevel {
  return state.level;
}

export function subscribeLogs(listener: () => void): () => void {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

export function getLogs(): LogEntry[] {
  restore();
  return state.entries;
}

export function getServerLogs(): LogEntry[] {
  return EMPTY_ENTRIES;
}

export function clearLogs(): void {
  state.entries = EMPTY_ENTRIES;
  state.seq = 0;
  persistNow();
  emit();
}

export function logsAsText(): string {
  const entries = getLogs();
  if (entries.length === 0) return "No log entries.";

  const lines = entries.map((entry) => {
    const data = entry.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`;
    return `+${(entry.tPlus / 1000).toFixed(3)}s ${entry.level.padEnd(5)} ${entry.scope} ${entry.event}${data}`;
  });

  return [`# file-transfer client log (${entries.length} entries)`, ...lines].join("\n");
}

export function logsAsJson(): string {
  return JSON.stringify({ exportedAt: new Date().toISOString(), entries: getLogs() }, null, 2);
}

let globalHandlersInstalled = false;

/** Captures crashes that happen outside our try/catch blocks. */
export function installGlobalHandlers(role: LogRole): void {
  if (globalHandlersInstalled || !isBrowser()) return;
  globalHandlersInstalled = true;

  const log = createLogger("window", role);

  window.addEventListener("error", (event) => {
    log.error("error", { message: event.message, source: event.filename, line: event.lineno });
  });

  window.addEventListener("unhandledrejection", (event) => {
    log.error("unhandledrejection", { reason: event.reason });
  });

  document.addEventListener("visibilitychange", () => {
    log.info("visibility", { state: document.visibilityState });
  });

  window.addEventListener("pagehide", () => {
    log.info("pagehide");
    persistNow();
  });
}
