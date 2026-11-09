import "server-only";
import { z } from "zod";
import { randomCode, randomToken, sha256Hex } from "./crypto";
import { RoomError } from "./errors";
import { getRedis } from "./redis";
import { RedisRoomStore } from "./redis-room-store";
import type { RoomStore } from "./room-store";

export const ROOM_TTL_SECONDS = 120;
const CODE_ATTEMPTS = 10;

export const codeSchema = z.string().regex(/^\d{4}$/, "Code must be 4 digits");

export const sdpSchema = z.object({
  type: z.string().min(1).max(16),
  sdp: z.string().min(1).max(16_384),
});

export const offerSchema = sdpSchema.extend({ type: z.literal("offer") });
export const answerSchema = sdpSchema.extend({ type: z.literal("answer") });

export type SdpPayload = z.infer<typeof sdpSchema>;

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
    };

    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const code = this.codeGenerator();
      if (await this.store.createIfAbsent(code, record, this.ttlSeconds)) {
        return { code, token };
      }
    }

    throw new RoomError("CONFLICT", "Could not allocate a room code. Try again.");
  }

  async claimRoom(code: string): Promise<{ offer: SdpPayload; claimToken: string }> {
    const claimToken = this.claimTokenGenerator();
    const claimTokenHash = await sha256Hex(claimToken);
    const outcome = await this.store.claim(code, claimTokenHash);

    switch (outcome.status) {
      case "not_found":
        throw new RoomError("NOT_FOUND", "Room not found or expired.");
      case "already_claimed":
        throw new RoomError("CLAIMED", "This code has already been claimed.");
      case "claimed":
        return { offer: outcome.room.offer, claimToken };
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
        throw new RoomError("CONFLICT", "Answer already submitted.");
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
