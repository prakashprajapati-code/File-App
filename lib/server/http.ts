import type { NextRequest } from "next/server";
import { RoomError, statusForRoomError } from "./errors";
import { checkRateLimit } from "./rate-limit";
import { getClientIp } from "./request";
import { fail } from "./response";

/** Returns a 429 response when the caller is over the limit, otherwise null. */
export async function enforceRateLimit(request: NextRequest): Promise<Response | null> {
  const allowed = await checkRateLimit(getClientIp(request));
  if (allowed) return null;
  return fail("RATE_LIMITED", "Too many attempts. Try again in a minute.", 429);
}

export function toErrorResponse(error: unknown): Response {
  if (error instanceof RoomError) {
    return fail(error.code, error.message, statusForRoomError(error.code));
  }

  // Never log raw errors: Upstash errors include the full command, which can
  // contain SDP. Only the error type is safe to record.
  console.error("Room API error:", error instanceof Error ? error.name : "Unknown error");
  return fail("INTERNAL", "Something went wrong.", 500);
}
