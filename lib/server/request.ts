import type { NextRequest } from "next/server";

/**
 * Vercel sets `x-forwarded-for`; the first entry is the client.
 * Locally the header is absent and all requests share the "unknown" bucket.
 */
export function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}
