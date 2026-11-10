import type { NextRequest } from "next/server";
import { readClientLog } from "@/lib/server/log-store";
import { checkLogRateLimit } from "@/lib/server/rate-limit";
import { getClientIp } from "@/lib/server/request";
import { fail, ok } from "@/lib/server/response";

type RouteParams = { params: Promise<{ id: string }> };

const LOG_ID_PATTERN = /^[a-z0-9]{6,32}$/;

/** Reads an uploaded client log by its short id (the id itself is the capability). */
export async function GET(request: NextRequest, ctx: RouteParams) {
  if (!(await checkLogRateLimit(getClientIp(request)))) {
    return fail("RATE_LIMITED", "Too many log reads. Try again in a minute.", 429);
  }

  const { id } = await ctx.params;
  if (!LOG_ID_PATTERN.test(id)) {
    return fail("INVALID", "Invalid log id.", 400);
  }

  try {
    const payload = await readClientLog(id);
    if (!payload) return fail("NOT_FOUND", "Log not found or expired.", 404);
    return ok(payload);
  } catch {
    return fail("INTERNAL", "Could not read the log.", 500);
  }
}
