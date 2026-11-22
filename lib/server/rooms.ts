import "server-only";
import { z } from "zod";
import type {
  GetCandidatesResult,
  IceCandidatePayload,
  IceSide,
  PostCandidatesResult,
} from "@/lib/rooms/contract";
import { MAX_ICE_CANDIDATES_PER_POST, ROOM_TTL_SECONDS } from "@/lib/rooms/config";
import { randomCode, randomToken, sha256Hex } from "./crypto";
import { RoomError } from "./errors";
import { getRedis } from "./redis";
import { RedisRoomStore } from "./redis-room-store";
import type { RoomStore } from "./room-store";

export { ROOM_TTL_SECONDS };

const CODE_ATTEMPTS = 10;

export const codeSchema = z.string().regex(/^\d{4}$/, "Code must be 4 digits");

export const sdpSchema = z.object({
  type: z.string().min(1).max(16),
  sdp: z.string().min(1).max(16_384),
});

export const offerSchema = sdpSchema.extend({ type: z.literal("offer") });
export const answerSchema = sdpSchema.extend({ type: z.literal("answer") });

export type SdpPayload = z.infer<typeof sdpSchema>;

export type { GetCandidatesResult, IceCandidatePayload, IceSide, PostCandidatesResult };

/**
 * A single trickled ICE candidate. `sdpMid` and `sdpMLineIndex` are both kept:
 * browsers accept either one, and some Android builds only set the media index.
 */
export interface IceAuth {
  role: IceSide;
  token: string;
}

export const iceCandidateSchema = z.object({
  candidate: z.string().min(1).max(1_024),
  sdpMid: z.string().max(64).nullish(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullish(),
  usernameFragment: z.string().max(256).nullish(),
});

export const candidatesBodySchema = z.object({
  candidates: z.array(iceCandidateSchema).max(MAX_ICE_CANDIDATES_PER_POST),
  complete: z.boolean().optional(),
});

export type CandidatesBody = z.infer<typeof candidatesBodySchema>;

export function normalizeIceCandidate(candidate: z.infer<typeof iceCandidateSchema>): IceCandidatePayload {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    usernameFragment: candidate.usernameFragment ?? null,
  };
}

export interface RoomIce {
  tv: IceCandidatePayload[];
  phone: IceCandidatePayload[];
  tvComplete: boolean;
  phoneComplete: boolean;
}

export function emptyRoomIce(): RoomIce {
  return { tv: [], phone: [], tvComplete: false, phoneComplete: false };
}

/**
 * The mailbox record. `tokenHash` belongs to the TV; `claimTokenHash` is set
 * when a phone claims the room. Neither hash is ever returned to a client.
 */
export interface RoomRecord {
  offer: SdpPayload;
  answer: SdpPayload | null;
  claimed: boolean;
  tokenHash: string;
  claimTokenHash: string | null;
  ice: RoomIce;
}

export interface RoomsServiceOptions {
  codeGenerator?: () => string;
  tokenGenerator?: () => string;
  claimTokenGenerator?: () => string;
  ttlSeconds?: number;
}

export class RoomsService {
  private readonly store: RoomStore;
  private readonly codeGenerator: () => string;
  private readonly tokenGenerator: () => string;
  private readonly claimTokenGenerator: () => string;
  private readonly ttlSeconds: number;

  constructor(store: RoomStore, options: RoomsServiceOptions = {}) {
    this.store = store;
    this.codeGenerator = options.codeGenerator ?? randomCode;
    this.tokenGenerator = options.tokenGenerator ?? (() => randomToken(32));
    this.claimTokenGenerator = options.claimTokenGenerator ?? (() => randomToken(32));
    this.ttlSeconds = options.ttlSeconds ?? ROOM_TTL_SECONDS;
  }

  async createRoom(offer: SdpPayload): Promise<{ code: string; token: string }> {
    const token = this.tokenGenerator();
    const tokenHash = await sha256Hex(token);
    const record: RoomRecord = {
      offer,
      answer: null,
      claimed: false,
      tokenHash,
      claimTokenHash: null,
      ice: emptyRoomIce(),
    };

    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const code = this.codeGenerator();
      if (await this.store.createIfAbsent(code, record, this.ttlSeconds)) {
        return { code, token };
      }
    }

    throw new RoomError("CONFLICT", "Could not allocate a room code. Try again.");
  }

  /**
   * Claims a room. Passing the token the phone already holds makes claim retries
   * and page reloads idempotent: the same phone gets its room back, a different
   * phone still sees CLAIMED.
   */
  async claimRoom(code: string, claimToken?: string): Promise<{ offer: SdpPayload; claimToken: string }> {
    const token = claimToken ?? this.claimTokenGenerator();
    const claimTokenHash = await sha256Hex(token);
    const outcome = await this.store.claim(code, claimTokenHash);

    switch (outcome.status) {
      case "not_found":
        throw new RoomError("NOT_FOUND", "Room not found or expired.");
      case "already_claimed":
        throw new RoomError("CLAIMED", "This code has already been claimed.");
      case "claimed":
        return { offer: outcome.room.offer, claimToken: token };
    }
  }

  async postAnswer(code: string, answer: SdpPayload, claimToken: string): Promise<void> {
    const claimTokenHash = await sha256Hex(claimToken);
    const outcome = await this.store.postAnswer(code, claimTokenHash, answer);

    switch (outcome.status) {
      case "not_found":
        throw new RoomError("NOT_FOUND", "Room not found or expired.");
      case "not_claimed":
        throw new RoomError("CONFLICT", "Room has not been claimed yet.");
      case "forbidden":
        throw new RoomError("FORBIDDEN", "Invalid claim token.");
      case "already_answered":
        throw new RoomError(
          "ANSWER_EXISTS",
          "This code was already used. Show a new code on the TV.",
        );
      case "ok":
        return;
    }
  }

  async getAnswer(code: string, token: string): Promise<SdpPayload | null> {
    const tokenHash = await sha256Hex(token);
    const outcome = await this.store.getAnswer(code, tokenHash);

    switch (outcome.status) {
      case "not_found":
        throw new RoomError("NOT_FOUND", "Room not found or expired.");
      case "forbidden":
        throw new RoomError("FORBIDDEN", "Invalid token.");
      case "ok":
        return outcome.answer;
    }
  }

  async postCandidates(
    code: string,
    auth: IceAuth,
    candidates: IceCandidatePayload[],
    complete: boolean,
  ): Promise<PostCandidatesResult> {
    const tokenHash = await sha256Hex(auth.token);
    const outcome = await this.store.postCandidates(
      code,
      auth.role,
      tokenHash,
      candidates,
      complete,
    );

    switch (outcome.status) {
      case "not_found":
        throw new RoomError("NOT_FOUND", "Room not found or expired.");
      case "forbidden":
        throw new RoomError("FORBIDDEN", "Invalid room token.");
      case "ok":
        return {
          accepted: outcome.accepted,
          duplicate: outcome.duplicate,
          dropped: outcome.dropped,
          total: outcome.total,
          complete: outcome.complete,
        };
    }
  }

  async getCandidates(code: string, auth: IceAuth, since: number): Promise<GetCandidatesResult> {
    const tokenHash = await sha256Hex(auth.token);
    const outcome = await this.store.getCandidates(code, auth.role, tokenHash, since);

    switch (outcome.status) {
      case "not_found":
        throw new RoomError("NOT_FOUND", "Room not found or expired.");
      case "forbidden":
        throw new RoomError("FORBIDDEN", "Invalid room token.");
      case "ok":
        return {
          candidates: outcome.candidates,
          next: outcome.next,
          total: outcome.total,
          complete: outcome.complete,
        };
    }
  }

  async deleteRoom(code: string, token: string): Promise<void> {
    const tokenHash = await sha256Hex(token);
    const outcome = await this.store.remove(code, tokenHash);

    switch (outcome.status) {
      case "not_found":
        throw new RoomError("NOT_FOUND", "Room not found or expired.");
      case "forbidden":
        throw new RoomError("FORBIDDEN", "Invalid token.");
      case "ok":
        return;
    }
  }
}

let service: RoomsService | undefined;

/** Production service backed by Upstash Redis. */
export function getRoomsService(): RoomsService {
  if (!service) {
    service = new RoomsService(new RedisRoomStore(getRedis()));
  }
  return service;
}
