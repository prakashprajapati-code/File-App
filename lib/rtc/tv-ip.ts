/**
 * Manual fallback for networks that block mDNS: the phone stores the TV's LAN
 * IP and rewrites the `.local` ICE candidates in the TV's offer.
 */

const STORAGE_KEY = "ft:tv-ip";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readTvIp(): string | null {
  const value = storage()?.getItem(STORAGE_KEY);
  return value && value.trim().length > 0 ? value.trim() : null;
}

export function writeTvIp(value: string): void {
  storage()?.setItem(STORAGE_KEY, value.trim());
}

export function clearTvIp(): void {
  storage()?.removeItem(STORAGE_KEY);
}
