import { ApiError } from "./api";

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Overridable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  shouldRetry?: (error: unknown) => boolean;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 300;
const DEFAULT_MAX_DELAY_MS = 3_000;

/** Network failures and server-side/rate-limit responses are safe to retry. */
export function isTransientError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof TypeError) return true;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/**
 * Retries idempotent pairing calls only. Never retries a 4xx that is not 429,
 * so "wrong token" and "already answered" surface immediately.
 */
export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const shouldRetry = options.shouldRetry ?? isTransientError;

  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !shouldRetry(error)) throw error;
      await sleep(jitter(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)));
    }
  }

  throw lastError;
}
