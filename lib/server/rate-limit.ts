import "server-only";
import { Ratelimit } from "@upstash/ratelimit";
import { getRedis } from "./redis";

const CLAIM_ATTEMPTS_PER_MINUTE = 10;

let limiter: Ratelimit | undefined;

function getLimiter(): Ratelimit {
  if (!limiter) {
    limiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(CLAIM_ATTEMPTS_PER_MINUTE, "1 m"),
      prefix: "ratelimit:rooms",
    });
  }
  return limiter;
}

/** Returns true when the caller is under the limit. */
export async function checkRateLimit(identifier: string): Promise<boolean> {
  const result = await getLimiter().limit(identifier);
  return result.success;
}
