import type { NextRequest } from "next/server";
import { toErrorResponse } from "@/lib/server/http";
import { fail } from "@/lib/server/response";
import {
  candidatesBodySchema,
  codeSchema,
  getRoomsService,
  normalizeIceCandidate,
} from "@/lib/server/rooms";
import type { IceAuth } from "@/lib/server/rooms";

type RouteParams = { params: Promise<{ code: string }> };

function readAuth(request: NextRequest): IceAuth | "conflict" | null {
  const tv = request.headers.get("x-token");
  const phone = request.headers.get("x-claim-token");

  if (tv && phone) return "conflict";
  if (tv) return { role: "tv", token: tv };
  if (phone) return { role: "phone", token: phone };
  return null;
}

/**
 * Phone posts with `x-claim-token`, TV with `x-token`. The candidate mailbox is
 * polled every few hundred ms during pairing, so this route deliberately skips
 * the room rate limiter; the 256-bit token is the authorization control.
 */
export async function POST(request: NextRequest, ctx: RouteParams) {
  const { code } = await ctx.params;
  const parsedCode = codeSchema.safeParse(code);
  if (!parsedCode.success) {
    return fail("INVALID", "Code must be 4 digits.", 400);
  }

  const auth = readAuth(request);
  if (auth === "conflict") {
    return fail("INVALID", "Send exactly one of x-token or x-claim-token.", 400);
  }
  if (auth === null) {
    return fail("FORBIDDEN", "Missing x-token or x-claim-token header.", 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID", "Body must be valid JSON.", 400);
  }

  const parsed = candidatesBodySchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID", "Body must contain valid ICE candidates.", 400);
  }

  try {
    const result = await getRoomsService().postCandidates(
      parsedCode.data,
      auth,
      parsed.data.candidates.map(normalizeIceCandidate),
      parsed.data.complete === true,
    );
    return new Response(JSON.stringify({ ok: true, data: result }), {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Returns the other side's candidates from `since` onward. */
export async function GET(request: NextRequest, ctx: RouteParams) {
  const { code } = await ctx.params;
  const parsedCode = codeSchema.safeParse(code);
  if (!parsedCode.success) {
    return fail("INVALID", "Code must be 4 digits.", 400);
  }

  const auth = readAuth(request);
  if (auth === "conflict") {
    return fail("INVALID", "Send exactly one of x-token or x-claim-token.", 400);
  }
  if (auth === null) {
    return fail("FORBIDDEN", "Missing x-token or x-claim-token header.", 403);
  }

  const sinceRaw = request.nextUrl.searchParams.get("since") ?? "0";
  const since = Number(sinceRaw);
  if (!Number.isInteger(since) || since < 0) {
    return fail("INVALID", "since must be a non-negative integer.", 400);
  }

  try {
    const result = await getRoomsService().getCandidates(parsedCode.data, auth, since);
    return new Response(JSON.stringify({ ok: true, data: result }), {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "x-candidate-total": String(result.total),
        "x-candidate-next": String(result.next),
        "x-candidate-complete": result.complete ? "1" : "0",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
