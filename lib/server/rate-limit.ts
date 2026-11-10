import "server-only";
import { Ratelimit } from "@upstash/ratelimit";
import { getRedis } from "./redis";

const CLAIM_ATTEMPTS_PER_MINUTE = 10;
const LOG_UPLOADS_PER_MINUTE = 30;

let limiter: Ratelimit | undefined;
let logLimiter: Ratelimit | undefined;

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

function getLogLimiter(): Ratelimit {
  if (!logLimiter) {
    logLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(LOG_UPLOADS_PER_MINUTE, "1 m"),
      prefix: "ratelimit:logs",
    });
  }
  return logLimiter;
}

/** Returns true when the caller is under the limit. */
export async function checkRateLimit(identifier: string): Promise<boolean> {
  const result = await getLimiter().limit(identifier);
  return result.success;
}

/**
 * Log uploads use their own bucket so a debugging session can never lock the
 * user out of pairing (both devices share one public IP on a hotspot).
 */
export async function checkLogRateLimit(identifier: string): Promise<boolean> {
  const result = await getLogLimiter().limit(identifier);
  return result.success;
}
