export type ControlMessage =
  | { t: "HELLO"; role: "tv" | "phone"; name: string }
  | { t: "CONFIRM" };

export function isControlMessage(value: unknown): value is ControlMessage {
  if (typeof value !== "object" || value === null || !("t" in value)) return false;
  const { t } = value as { t: unknown };
  return t === "HELLO" || t === "CONFIRM";
}
