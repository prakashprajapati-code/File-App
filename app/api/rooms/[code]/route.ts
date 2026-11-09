import type { NextRequest } from "next/server";
import { enforceRateLimit, toErrorResponse } from "@/lib/server/http";
import { fail, noContent, ok } from "@/lib/server/response";
import { codeSchema, getRoomsService } from "@/lib/server/rooms";

type RouteParams = { params: Promise<{ code: string }> };

/** Phone claims a room and receives the TV's offer plus a claim token. */
export async function GET(request: NextRequest, ctx: RouteParams) {
  const rateLimited = await enforceRateLimit(request);
  if (rateLimited) return rateLimited;

  const { code } = await ctx.params;
  const parsedCode = codeSchema.safeParse(code);
  if (!parsedCode.success) {
    return fail("INVALID", "Code must be 4 digits.", 400);
  }

  try {
    const claim = await getRoomsService().claimRoom(parsedCode.data);
    return ok(claim);
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** TV deletes the room after the connection is established. */
export async function DELETE(request: NextRequest, ctx: RouteParams) {
  const { code } = await ctx.params;
  const parsedCode = codeSchema.safeParse(code);
  if (!parsedCode.success) {
    return fail("INVALID", "Code must be 4 digits.", 400);
  }

  const token = request.headers.get("x-token");
  if (!token) {
    return fail("FORBIDDEN", "Missing x-token header.", 403);
  }

  try {
    await getRoomsService().deleteRoom(parsedCode.data, token);
    return noContent();
  } catch (error) {
    return toErrorResponse(error);
  }
}
