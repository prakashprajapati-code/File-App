import { describe, expect, it } from "vitest";
import { MemoryRoomStore } from "./room-store";
import { RoomsService, codeSchema, offerSchema, type SdpPayload } from "./rooms";

const offer: SdpPayload = {
  type: "offer",
  sdp: "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n",
};

const answer: SdpPayload = {
  type: "answer",
  sdp: "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\n",
};

function makeService(options: { now?: () => number; codes?: string[] } = {}) {
  const now = options.now ?? Date.now;
  const store = new MemoryRoomStore(now);
  const codes = options.codes ?? ["4821"];
  let codeIndex = 0;

  const service = new RoomsService(store, {
    codeGenerator: () => codes[Math.min(codeIndex++, codes.length - 1)],
    tokenGenerator: () => "tv-token",
    claimTokenGenerator: () => "phone-claim-token",
  });

  return { service, store };
}

describe("RoomsService", () => {
  it("creates a room with a 4-digit code and a TV token", async () => {
    const { service } = makeService();

    const room = await service.createRoom(offer);

    expect(room.code).toMatch(/^\d{4}$/);
    expect(room.token).toBe("tv-token");
  });

  it("retries when a code is already taken", async () => {
    const { service } = makeService({ codes: ["4821", "4821", "1234"] });

    const first = await service.createRoom(offer);
    const second = await service.createRoom(offer);

    expect(first.code).toBe("4821");
    expect(second.code).toBe("1234");
  });

  it("lets exactly one phone claim a room", async () => {
    const { service } = makeService();
    const { code } = await service.createRoom(offer);

    const claim = await service.claimRoom(code);

    expect(claim.offer).toEqual(offer);
    expect(claim.claimToken).toBe("phone-claim-token");
    await expect(service.claimRoom(code)).rejects.toMatchObject({ code: "CLAIMED" });
  });

  it("returns NOT_FOUND for an unknown code", async () => {
    const { service } = makeService();

    await expect(service.claimRoom("0000")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("expires a room after the TTL", async () => {
    let now = 0;
    const { service } = makeService({ now: () => now });
    const { code } = await service.createRoom(offer);

    now = 120_000;

    await expect(service.claimRoom(code)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("stores the answer and returns it to the TV", async () => {
    const { service } = makeService();
    const { code, token } = await service.createRoom(offer);
    const claim = await service.claimRoom(code);

    await service.postAnswer(code, answer, claim.claimToken);

    await expect(service.getAnswer(code, token)).resolves.toEqual(answer);
  });

  it("returns null while the answer is pending", async () => {
    const { service } = makeService();
    const { code, token } = await service.createRoom(offer);

    await expect(service.getAnswer(code, token)).resolves.toBeNull();
  });

  it("rejects a wrong claim token", async () => {
    const { service } = makeService();
    const { code } = await service.createRoom(offer);
    await service.claimRoom(code);

    await expect(service.postAnswer(code, answer, "wrong")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects a wrong TV token", async () => {
    const { service } = makeService();
    const { code } = await service.createRoom(offer);

    await expect(service.getAnswer(code, "wrong")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.deleteRoom(code, "wrong")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("deletes a room exactly once", async () => {
    const { service } = makeService();
    const { code, token } = await service.createRoom(offer);

    await service.deleteRoom(code, token);

    await expect(service.deleteRoom(code, token)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a second answer", async () => {
    const { service } = makeService();
    const { code } = await service.createRoom(offer);
    const claim = await service.claimRoom(code);
    await service.postAnswer(code, answer, claim.claimToken);

    await expect(service.postAnswer(code, answer, claim.claimToken)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("rejects an answer before the room is claimed", async () => {
    const { service } = makeService();
    const { code } = await service.createRoom(offer);

    await expect(service.postAnswer(code, answer, "phone-claim-token")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("schemas", () => {
  it("accepts only 4-digit codes", () => {
    expect(codeSchema.safeParse("4821").success).toBe(true);
    expect(codeSchema.safeParse("482").success).toBe(false);
    expect(codeSchema.safeParse("12345").success).toBe(false);
    expect(codeSchema.safeParse("abcd").success).toBe(false);
  });

  it("requires the offer type", () => {
    expect(offerSchema.safeParse({ type: "offer", sdp: "v=0" }).success).toBe(true);
    expect(offerSchema.safeParse({ type: "answer", sdp: "v=0" }).success).toBe(false);
  });
});
