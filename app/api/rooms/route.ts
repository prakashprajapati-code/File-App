import type { NextRequest } from "next/server";
import { z } from "zod";
import { enforceRateLimit, toErrorResponse } from "@/lib/server/http";
import { fail, ok } from "@/lib/server/response";
import { getRoomsService, offerSchema } from "@/lib/server/rooms";

const createRoomBodySchema = z.object({ offer: offerSchema });

/** TV creates a room and receives a code + token. */
export async function POST(request: NextRequest) {
  const rateLimited = await enforceRateLimit(request);
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID", "Body must be valid JSON.", 400);
  }

  const parsed = createRoomBodySchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID", "Body must contain a valid WebRTC offer.", 400);
  }

  try {
    const room = await getRoomsService().createRoom(parsed.data.offer);
    return ok(room, 201);
  } catch (error) {
    return toErrorResponse(error);
  }
}
