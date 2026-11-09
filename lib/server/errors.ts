export type RoomErrorCode =
  | "NOT_FOUND"
  | "CLAIMED"
  | "CONFLICT"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "INVALID";

export class RoomError extends Error {
  readonly code: RoomErrorCode;

  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

export function statusForRoomError(code: RoomErrorCode): number {
  switch (code) {
    case "INVALID":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CLAIMED":
    case "CONFLICT":
      return 409;
    case "RATE_LIMITED":
      return 429;
  }
}
