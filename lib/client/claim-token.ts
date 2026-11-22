/**
 * The claim token is the phone's capability for the room. Persisting it in
 * sessionStorage makes a reload before the answer was posted resume the same
 * claim instead of failing with "already claimed".
 */

const PREFIX = "ft:claim:v1:";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function claimTokenKey(code: string): string {
  return `${PREFIX}${code}`;
}

export function readClaimToken(code: string, store: StorageLike | null = defaultStorage()): string | null {
  const value = store?.getItem(claimTokenKey(code));
  return value && value.length > 0 ? value : null;
}

export function writeClaimToken(
  code: string,
  token: string,
  store: StorageLike | null = defaultStorage(),
): void {
  try {
    store?.setItem(claimTokenKey(code), token);
  } catch {
    // Private mode / quota: pairing still works for this page load.
  }
}

export function clearClaimToken(code: string, store: StorageLike | null = defaultStorage()): void {
  try {
    store?.removeItem(claimTokenKey(code));
  } catch {
    // Ignore storage failures.
  }
}

/** 256-bit URL-safe token generated before the claim request. */
export function createClaimToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
