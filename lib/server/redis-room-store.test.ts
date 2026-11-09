import type { Redis } from "@upstash/redis";
import { describe, expect, it, vi } from "vitest";
import { RedisRoomStore } from "./redis-room-store";
import type { RoomRecord, SdpPayload } from "./rooms";

const record: RoomRecord = {
  offer: { type: "offer", sdp: "v=0\r\n" },
  answer: null,
  claimed: false,
  tokenHash: "tv-token-hash",
  claimTokenHash: null,
};

const answer: SdpPayload = {
  type: "answer",
  sdp: "v=0\r\n",
};

/** Builds a Redis stub whose eval calls return the given results in order. */
function fakeRedis(results: unknown[]): Redis {
  const evalMock = vi.fn();
  for (const result of results) {
    evalMock.mockResolvedValueOnce(result);
  }
  return { eval: evalMock } as unknown as Redis;
}

describe("RedisRoomStore", () => {
  it("claims a room when Upstash returns an already-parsed record", async () => {
    const store = new RedisRoomStore(fakeRedis([[1, record]]));

    await expect(store.claim("4821", "phone-token-hash")).resolves.toEqual({
      status: "claimed",
      room: record,
    });
  });

  it("still accepts a raw JSON string from other clients", async () => {
    const store = new RedisRoomStore(fakeRedis([[1, JSON.stringify(record)]]));

    await expect(store.claim("4821", "phone-token-hash")).resolves.toEqual({
      status: "claimed",
      room: record,
    });
  });

  it("returns an already-parsed answer", async () => {
    const store = new RedisRoomStore(fakeRedis([[1, answer]]));

    await expect(store.getAnswer("4821", "tv-token-hash")).resolves.toEqual({
      status: "ok",
      answer,
    });
  });

  it("maps not-found and already-claimed statuses", async () => {
    const store = new RedisRoomStore(fakeRedis([[0], [2]]));

    await expect(store.claim("0000", "phone-token-hash")).resolves.toEqual({
      status: "not_found",
    });
    await expect(store.claim("4821", "phone-token-hash")).resolves.toEqual({
      status: "already_claimed",
    });
  });

  it("fails loudly when a successful status has no payload", async () => {
    const store = new RedisRoomStore(fakeRedis([[1]]));

    await expect(store.claim("4821", "phone-token-hash")).rejects.toThrow(
      "Missing room payload.",
    );
  });
});
