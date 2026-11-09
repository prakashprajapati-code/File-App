import type { NextRequest } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/server/http";
import { fail, noContent, ok } from "@/lib/server/response";
import { answerSchema, codeSchema, getRoomsService } from "@/lib/server/rooms";

type RouteParams = { params: Promise<{ code: string }> };

const postAnswerBodySchema = z.object({ answer: answerSchema });

/** Phone posts its answer. Requires the claim token issued by GET /api/rooms/[code]. */
export async function POST(request: NextRequest, ctx: RouteParams) {
  const { code } = await ctx.params;
  const parsedCode = codeSchema.safeParse(code);
  if (!parsedCode.success) {
    return fail("INVALID", "Code must be 4 digits.", 400);
  }

  const claimToken = request.headers.get("x-claim-token");
  if (!claimToken) {
    return fail("FORBIDDEN", "Missing x-claim-token header.", 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID", "Body must be valid JSON.", 400);
  }

  const parsed = postAnswerBodySchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID", "Body must contain a valid WebRTC answer.", 400);
  }

  try {
    await getRoomsService().postAnswer(parsedCode.data, parsed.data.answer, claimToken);
    return noContent();
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** TV polls for the answer. 204 while it has not arrived yet. */
export async function GET(request: NextRequest, ctx: RouteParams) {
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
    const answer = await getRoomsService().getAnswer(parsedCode.data, token);
    if (!answer) return noContent();
    return ok({ answer });
  } catch (error) {
    return toErrorResponse(error);
  }
}
