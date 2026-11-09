import "server-only";
import { Redis } from "@upstash/redis";
import { getEnv } from "@/lib/env";

let client: Redis | undefined;

/** Lazily creates the Upstash REST client. */
export function getRedis(): Redis {
  if (!client) {
    const env = getEnv();
    client = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return client;
}
