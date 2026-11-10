import type { LogValue } from "./types";

const REDACTED = "<redacted>";
const DEPTH_LIMIT = "<depth-limit>";
const CIRCULAR = "<circular>";

/**
 * SDP and tokens must never leave the device (see doc/plan.md: "Never log SDP"),
 * so anything with these words in the key is replaced before it is stored.
 */
const SECRET_KEY_PATTERN = /sdp|token|password|secret|authorization|cookie|credential/i;

const IPV4_WITH_MASK = /(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}/g;

const MAX_STRING_LENGTH = 300;
const MAX_ARRAY_LENGTH = 50;
const MAX_OBJECT_KEYS = 40;
const MAX_DEPTH = 5;

/**
 * Keeps the subnet readable for debugging while hiding the host address:
 * `192.168.43.10` becomes `192.168.x.x`.
 */
export function maskAddress(value: string): string {
  return value.replace(IPV4_WITH_MASK, "$1.x.x");
}

/** Converts any value into a JSON-safe, size-limited, secret-free shape. */
export function redact(value: unknown): LogValue {
  return redactValue(value, 0, new WeakSet<object>());
}

function truncate(value: string): string {
  const masked = maskAddress(value);
  return masked.length > MAX_STRING_LENGTH ? `${masked.slice(0, MAX_STRING_LENGTH)}…` : masked;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): LogValue {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case "string":
      return truncate(value);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
      return "[function]";
    case "symbol":
      return value.toString();
    default:
      break;
  }

  if (value instanceof Error) {
    return { name: value.name, message: truncate(value.message) };
  }

  if (typeof value !== "object") return String(value);
  if (depth >= MAX_DEPTH) return DEPTH_LIMIT;
  if (seen.has(value)) return CIRCULAR;

  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => redactValue(item, depth + 1, seen));
  }

  if (value instanceof Map) {
    const out: Record<string, LogValue> = {};
    for (const [key, item] of Array.from(value.entries()).slice(0, MAX_OBJECT_KEYS)) {
      out[String(key)] = redactValue(item, depth + 1, seen);
    }
    return out;
  }

  if (value instanceof Set) {
    return Array.from(value.values())
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => redactValue(item, depth + 1, seen));
  }

  const out: Record<string, LogValue> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(item, depth + 1, seen);
  }
  return out;
}
