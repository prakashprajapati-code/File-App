import type { RoomRecord, SdpPayload } from "./rooms";

export type ClaimOutcome =
  | { status: "claimed"; room: RoomRecord }
  | { status: "not_found" }
  | { status: "already_claimed" };

export type PostAnswerOutcome =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "not_claimed" }
  | { status: "forbidden" }
  | { status: "already_answered" };

export type GetAnswerOutcome =
  | { status: "ok"; answer: SdpPayload | null }
  | { status: "not_found" }
  | { status: "forbidden" };

export type DeleteOutcome =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "forbidden" };

export interface RoomStore {
  /** Stores the room only if the code is still free. Returns false on collision. */
  createIfAbsent(code: string, record: RoomRecord, ttlSeconds: number): Promise<boolean>;
  /** Atomically marks the room claimed and records the phone's claim token hash. */
  claim(code: string, claimTokenHash: string): Promise<ClaimOutcome>;
  postAnswer(code: string, claimTokenHash: string, answer: SdpPayload): Promise<PostAnswerOutcome>;
  getAnswer(code: string, tokenHash: string): Promise<GetAnswerOutcome>;
  remove(code: string, tokenHash: string): Promise<DeleteOutcome>;
}

type Entry = { record: RoomRecord; expiresAt: number };

/** In-memory store used by unit tests. Never use this in production. */
export class MemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private live(code: string): RoomRecord | null {
    const entry = this.rooms.get(code);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.rooms.delete(code);
      return null;
    }
    return entry.record;
  }

  async createIfAbsent(code: string, record: RoomRecord, ttlSeconds: number): Promise<boolean> {
    if (this.live(code)) return false;
    this.rooms.set(code, {
      record,
      expiresAt: this.now() + ttlSeconds * 1000,
    });
    return true;
  }

  async claim(code: string, claimTokenHash: string): Promise<ClaimOutcome> {
    const record = this.live(code);
    if (!record) return { status: "not_found" };
    if (record.claimed) return { status: "already_claimed" };

    record.claimed = true;
    record.claimTokenHash = claimTokenHash;
    return { status: "claimed", room: record };
  }

  async postAnswer(
    code: string,
    claimTokenHash: string,
    answer: SdpPayload,
  ): Promise<PostAnswerOutcome> {
    const record = this.live(code);
    if (!record) return { status: "not_found" };
    if (!record.claimed) return { status: "not_claimed" };
    if (record.claimTokenHash !== claimTokenHash) return { status: "forbidden" };
    if (record.answer) return { status: "already_answered" };

    record.answer = answer;
    return { status: "ok" };
  }

  async getAnswer(code: string, tokenHash: string): Promise<GetAnswerOutcome> {
    const record = this.live(code);
    if (!record) return { status: "not_found" };
    if (record.tokenHash !== tokenHash) return { status: "forbidden" };
    return { status: "ok", answer: record.answer };
  }

  async remove(code: string, tokenHash: string): Promise<DeleteOutcome> {
    const record = this.live(code);
    if (!record) return { status: "not_found" };
    if (record.tokenHash !== tokenHash) return { status: "forbidden" };

    this.rooms.delete(code);
    return { status: "ok" };
  }
}
