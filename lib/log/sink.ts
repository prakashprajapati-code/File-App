import type { LogEntry, LogRole } from "./types";

export interface LogUploadResult {
  id: string;
  stored: boolean;
}

const MAX_UPLOAD_ENTRIES = 300;

function parseUploadResult(value: unknown): LogUploadResult | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (body.ok !== true) return null;
  if (typeof body.data !== "object" || body.data === null) return null;

  const data = body.data as Record<string, unknown>;
  if (typeof data.id !== "string") return null;

  return { id: data.id, stored: data.stored === true };
}

/** Best-effort upload. A failed upload must never break the page. */
export async function uploadLogs(
  entries: readonly LogEntry[],
  role: LogRole,
): Promise<LogUploadResult | null> {
  if (entries.length === 0) return null;

  const payload = entries.slice(-MAX_UPLOAD_ENTRIES);

  try {
    const response = await fetch("/api/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        role,
        sessionId: payload[0]?.sessionId ?? "unknown",
        entries: payload,
      }),
      keepalive: true,
    });

    if (!response.ok) return null;

    const body: unknown = await response.json();
    return parseUploadResult(body);
  } catch {
    return null;
  }
}
