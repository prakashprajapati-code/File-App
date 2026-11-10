import "server-only";
import type { LogEntry } from "@/lib/log/types";
import { getRedis } from "./redis";

const LOG_TTL_SECONDS = 3600;
const MAX_STORED_ENTRIES = 300;

export interface StoredClientLog {
  savedAt: number;
  role: string;
  entries: LogEntry[];
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isStoredClientLog(value: unknown): value is StoredClientLog {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.savedAt === "number" && Array.isArray(record.entries);
}

/** Keeps the uploaded log for one hour so the TV and the phone can read it. */
export async function saveClientLog(
  id: string,
  role: string,
  entries: LogEntry[],
): Promise<void> {
  const payload: StoredClientLog = {
    savedAt: Date.now(),
    role,
    entries: entries.slice(-MAX_STORED_ENTRIES),
  };

  await getRedis().set(`log:${id}`, JSON.stringify(payload), { ex: LOG_TTL_SECONDS });
}

export async function readClientLog(id: string): Promise<StoredClientLog | null> {
  // Upstash auto-deserializes JSON it stored itself, other clients return strings.
  const raw = await getRedis().get<unknown>(`log:${id}`);
  if (raw === null || raw === undefined) return null;

  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  return isStoredClientLog(parsed) ? parsed : null;
}
