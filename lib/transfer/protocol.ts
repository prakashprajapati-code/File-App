export interface FileMeta {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  lastModified: number;
}

export type ControlMessage =
  | { t: "HELLO"; role: "tv" | "phone"; name: string }
  | { t: "CONFIRM" }
  | { t: "REJECT"; reason: string }
  | ({ t: "META" } & FileMeta)
  | { t: "ACCEPT"; fileId: string; offset: number }
  | { t: "ACK"; offset: number }
  | { t: "DONE"; size: number; hash: string }
  | { t: "COMPLETE"; hash: string }
  | { t: "CANCEL" }
  | { t: "ERROR"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Validates a control-channel payload. Every field is checked so a malformed
 * message from the peer is ignored instead of crashing the transfer.
 */
export function isControlMessage(value: unknown): value is ControlMessage {
  if (!isRecord(value)) return false;

  switch (value.t) {
    case "HELLO":
      return (value.role === "tv" || value.role === "phone") && typeof value.name === "string";
    case "CONFIRM":
      return true;
    case "REJECT":
      return typeof value.reason === "string";
    case "META":
      return (
        isNonEmptyString(value.fileId) &&
        typeof value.name === "string" &&
        isNonNegativeNumber(value.size) &&
        typeof value.mime === "string" &&
        isNonNegativeNumber(value.lastModified)
      );
    case "ACCEPT":
      return isNonEmptyString(value.fileId) && isNonNegativeNumber(value.offset);
    case "ACK":
      return isNonNegativeNumber(value.offset);
    case "DONE":
      return isNonNegativeNumber(value.size) && isNonEmptyString(value.hash);
    case "COMPLETE":
      return isNonEmptyString(value.hash);
    case "CANCEL":
      return true;
    case "ERROR":
      return typeof value.message === "string";
    default:
      return false;
  }
}
