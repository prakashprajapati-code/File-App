import type {
  GetCandidatesResult,
  IceCandidatePayload,
  IceSide,
  PostCandidatesResult,
  RoomIce,
  RoomRecord,
  SdpPayload,
} from "./rooms";
import { emptyRoomIce } from "./rooms";
import { MAX_ICE_CANDIDATES } from "@/lib/rooms/config";

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

export type PostCandidatesOutcome =
  | ({ status: "ok" } & PostCandidatesResult)
  | { status: "not_found" }
  | { status: "forbidden" };

export type GetCandidatesOutcome =
  | ({ status: "ok" } & GetCandidatesResult)
  | { status: "not_found" }
  | { status: "forbidden" };

export type DeleteOutcome =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "forbidden" };

export interface RoomStore {
  /** Stores the room only if the code is still free. Returns false on collision. */
  createIfAbsent(code: string, record: RoomRecord, ttlSeconds: number): Promise<boolean>;
  /**
   * Atomically marks the room claimed. Re-claiming with the same token hash is
   * idempotent so a retried request or a reload does not lock the phone out.
   */
  claim(code: string, claimTokenHash: string): Promise<ClaimOutcome>;
  postAnswer(code: string, claimTokenHash: string, answer: SdpPayload): Promise<PostAnswerOutcome>;
  getAnswer(code: string, tokenHash: string): Promise<GetAnswerOutcome>;
  /** Appends candidates for one side. Idempotent and capped. */
  postCandidates(
    code: string,
    role: IceSide,
    tokenHash: string,
    candidates: IceCandidatePayload[],
    complete: boolean,
  ): Promise<PostCandidatesOutcome>;
  /** Returns the *other* side's candidates from `since` onward. */
  getCandidates(
    code: string,
    role: IceSide,
    tokenHash: string,
    since: number,
  ): Promise<GetCandidatesOutcome>;
  remove(code: string, tokenHash: string): Promise<DeleteOutcome>;
}

type Entry = { record: RoomRecord; expiresAt: number };

export function iceCandidateKey(candidate: IceCandidatePayload): string {
  const mid = candidate.sdpMid ?? "";
  const index = candidate.sdpMLineIndex === null ? "" : String(candidate.sdpMLineIndex);
  return `${mid}|${index}|${candidate.candidate}`;
}

/** Adds candidates to one side, ignoring duplicates and respecting the cap. */
export function appendCandidates(
  ice: RoomIce,
  side: IceSide,
  candidates: readonly IceCandidatePayload[],
  complete: boolean,
): PostCandidatesResult {
  const list = side === "tv" ? ice.tv : ice.phone;
  const seen = new Set(list.map(iceCandidateKey));

  let accepted = 0;
  let duplicate = 0;
  let dropped = 0;

  for (const candidate of candidates) {
    const key = iceCandidateKey(candidate);
    if (seen.has(key)) {
      duplicate += 1;
      continue;
    }
    if (list.length >= MAX_ICE_CANDIDATES) {
      dropped += 1;
      continue;
    }
    list.push(candidate);
    seen.add(key);
    accepted += 1;
  }

  if (complete) {
    if (side === "tv") ice.tvComplete = true;
    else ice.phoneComplete = true;
  }

  return {
    accepted,
    duplicate,
    dropped,
    total: list.length,
    complete: side === "tv" ? ice.tvComplete : ice.phoneComplete,
  };
}

function readIce(record: RoomRecord): RoomIce {
  // Rooms created before the candidate mailbox existed have no `ice` field.
  const legacy = record as RoomRecord & { ice?: RoomIce };
  if (!legacy.ice) legacy.ice = emptyRoomIce();
  if (!Array.isArray(legacy.ice.tv)) legacy.ice.tv = [];
  if (!Array.isArray(legacy.ice.phone)) legacy.ice.phone = [];
  return legacy.ice;
}

function isAuthorized(record: RoomRecord, role: IceSide, tokenHash: string): boolean {
  if (role === "tv") return record.tokenHash === tokenHash;
  return record.claimed && record.claimTokenHash === tokenHash;
}

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

    if (record.claimed) {
      return record.claimTokenHash === claimTokenHash
        ? { status: "claimed", room: record }
        : { status: "already_claimed" };
    }

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

    if (record.answer) {
      const same = record.answer.sdp === answer.sdp && record.answer.type === answer.type;
      return same ? { status: "ok" } : { status: "already_answered" };
    }

    record.answer = answer;
    return { status: "ok" };
  }

  async getAnswer(code: string, tokenHash: string): Promise<GetAnswerOutcome> {
    const record = this.live(code);
    if (!record) return { status: "not_found" };
    if (record.tokenHash !== tokenHash) return { status: "forbidden" };
    return { status: "ok", answer: record.answer };
  }

  async postCandidates(
    code: string,
    role: IceSide,
    tokenHash: string,
    candidates: IceCandidatePayload[],
    complete: boolean,
  ): Promise<PostCandidatesOutcome> {
    const record = this.live(code);
    if (!record) return { status: "not_found" };
    if (!isAuthorized(record, role, tokenHash)) return { status: "forbidden" };

    const result = appendCandidates(readIce(record), role, candidates, complete);
    return { status: "ok", ...result };
  }

  async getCandidates(
    code: string,
    role: IceSide,
    tokenHash: string,
    since: number,
  ): Promise<GetCandidatesOutcome> {
    const record = this.live(code);
    if (!record) return { status: "not_found" };
    if (!isAuthorized(record, role, tokenHash)) return { status: "forbidden" };

    const ice = readIce(record);
    const list = role === "tv" ? ice.phone : ice.tv;
    const complete = role === "tv" ? ice.phoneComplete : ice.tvComplete;
    const start = Math.max(0, Math.min(since, list.length));

    return {
      status: "ok",
      candidates: list.slice(start),
      next: list.length,
      total: list.length,
      complete,
    };
  }

  async remove(code: string, tokenHash: string): Promise<DeleteOutcome> {
    const record = this.live(code);
    if (!record) return { status: "not_found" };
    if (record.tokenHash !== tokenHash) return { status: "forbidden" };

    this.rooms.delete(code);
    return { status: "ok" };
  }
}
