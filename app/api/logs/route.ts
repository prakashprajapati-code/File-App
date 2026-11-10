import type { NextRequest } from "next/server";
import { z } from "zod";
import { redact } from "@/lib/log/redact";
import { LOG_LEVELS, LOG_ROLES } from "@/lib/log/types";
import type { LogEntry } from "@/lib/log/types";
import { saveClientLog } from "@/lib/server/log-store";
import { checkLogRateLimit } from "@/lib/server/rate-limit";
import { getClientIp } from "@/lib/server/request";
import { fail, ok } from "@/lib/server/response";

const MAX_BODY_CHARACTERS = 64_000;

const logEntrySchema = z.object({
  seq: z.number().int().min(0),
  ts: z.number().int().min(0),
  tPlus: z.number().min(0),
  level: z.enum(LOG_LEVELS),
  scope: z.string().min(1).max(60),
  event: z.string().min(1).max(120),
  sessionId: z.string().min(1).max(80),
  role: z.enum(LOG_ROLES),
  data: z.unknown().optional(),
});

const uploadBodySchema = z.object({
  role: z.enum(LOG_ROLES),
  sessionId: z.string().min(1).max(80),
  entries: z.array(logEntrySchema).min(1).max(300),
});

function randomLogId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

function stageTimeline(entries: readonly LogEntry[]): string {
  const stages = entries
    .filter((entry) => entry.event.startsWith("stage:"))
    .map((entry) => entry.event.slice("stage:".length));

  return stages.length > 0 ? stages.join(" > ") : "no stages";
}

/**
 * Accepts a client log batch (TV or phone). The payload is redacted again here
 * so an SDP or token can never reach the server logs, even from a stale client.
 */
export async function POST(request: NextRequest) {
  if (!(await checkLogRateLimit(getClientIp(request)))) {
    return fail("RATE_LIMITED", "Too many log uploads. Try again in a minute.", 429);
  }

  const raw = await request.text();
  if (raw.length === 0) return fail("INVALID", "Body must not be empty.", 400);
  if (raw.length > MAX_BODY_CHARACTERS) return fail("INVALID", "Log payload is too large.", 413);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail("INVALID", "Body must be valid JSON.", 400);
  }

  const parsed = uploadBodySchema.safeParse(body);
  if (!parsed.success) return fail("INVALID", "Body must contain log entries.", 400);

  const entries: LogEntry[] = parsed.data.entries.map((entry) => {
    const next: LogEntry = {
      seq: entry.seq,
      ts: entry.ts,
      tPlus: entry.tPlus,
      level: entry.level,
      scope: entry.scope,
      event: entry.event,
      sessionId: entry.sessionId,
      role: entry.role,
    };

    if (entry.data !== undefined) next.data = redact(entry.data);
    return next;
  });

  const id = randomLogId();

  // Always keep a copy in the platform log, in case Redis is unavailable.
  console.log(
    `[client-log] ${id} role=${parsed.data.role} entries=${entries.length} stages=${stageTimeline(entries)}`,
  );

  let stored = false;
  try {
    await saveClientLog(id, parsed.data.role, entries);
    stored = true;
  } catch (error) {
    console.error("[client-log] store failed", error instanceof Error ? error.name : "Unknown error");
  }

  return ok({ id, stored }, 201);
}
