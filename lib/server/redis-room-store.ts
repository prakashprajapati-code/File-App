import "server-only";
import type { Redis } from "@upstash/redis";
import type {
  ClaimOutcome,
  DeleteOutcome,
  GetAnswerOutcome,
  PostAnswerOutcome,
  RoomStore,
} from "./room-store";
import type { RoomRecord, SdpPayload } from "./rooms";

/**
 * Claims a room in one round trip. The room TTL is never extended by a claim.
 * Returns: 0 = not found, 1 = claimed (payload = previous JSON), 2 = already claimed.
 */
const CLAIM_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {0}
end
local room = cjson.decode(raw)
if room.claimed then
  return {2}
end
room.claimed = true
room.claimTokenHash = ARGV[1]
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 1 then
  return {0}
end
redis.call('SET', KEYS[1], cjson.encode(room), 'PX', ttl)
return {1, raw}
`;

/**
 * Stores the answer only if the caller holds the claim token and no answer exists.
 * Returns: 0 = not found, 1 = ok, 2 = not claimed, 3 = forbidden, 4 = already answered.
 */
const ANSWER_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local room = cjson.decode(raw)
if not room.claimed then
  return 2
end
if room.claimTokenHash ~= ARGV[1] then
  return 3
end
if room.answer then
  return 4
end
room.answer = cjson.decode(ARGV[2])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 1 then
  return 0
end
redis.call('SET', KEYS[1], cjson.encode(room), 'PX', ttl)
return 1
`;

/**
 * Returns: 0 = not found, 1 = answer present (payload), 2 = forbidden, 3 = pending.
 */
const GET_ANSWER_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {0}
end
local room = cjson.decode(raw)
if room.tokenHash ~= ARGV[1] then
  return {2}
end
if room.answer then
  return {1, cjson.encode(room.answer)}
end
return {3}
`;

/** Returns: 0 = not found, 1 = deleted, 2 = forbidden. */
const DELETE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local room = cjson.decode(raw)
if room.tokenHash ~= ARGV[1] then
  return 2
end
redis.call('DEL', KEYS[1])
return 1
`;

function roomKey(code: string): string {
  return `room:${code}`;
}

export class RedisRoomStore implements RoomStore {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async createIfAbsent(code: string, record: RoomRecord, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(roomKey(code), JSON.stringify(record), {
      nx: true,
      ex: ttlSeconds,
    });
    return result === "OK";
  }

  async claim(code: string, claimTokenHash: string): Promise<ClaimOutcome> {
    const result = await this.redis.eval<[string], [number, string?]>(
      CLAIM_SCRIPT,
      [roomKey(code)],
      [claimTokenHash],
    );

    const status = Number(result[0]);
    if (status === 0) return { status: "not_found" };
    if (status === 2) return { status: "already_claimed" };

    const record = JSON.parse(result[1] ?? "") as RoomRecord;
    return { status: "claimed", room: record };
  }

  async postAnswer(
    code: string,
    claimTokenHash: string,
    answer: SdpPayload,
  ): Promise<PostAnswerOutcome> {
    const result = await this.redis.eval<[string, string], number>(
      ANSWER_SCRIPT,
      [roomKey(code)],
      [claimTokenHash, JSON.stringify(answer)],
    );

    switch (Number(result)) {
      case 1:
        return { status: "ok" };
      case 2:
        return { status: "not_claimed" };
      case 3:
        return { status: "forbidden" };
      case 4:
        return { status: "already_answered" };
      default:
        return { status: "not_found" };
    }
  }

  async getAnswer(code: string, tokenHash: string): Promise<GetAnswerOutcome> {
    const result = await this.redis.eval<[string], [number, string?]>(
      GET_ANSWER_SCRIPT,
      [roomKey(code)],
      [tokenHash],
    );

    const status = Number(result[0]);
    if (status === 0) return { status: "not_found" };
    if (status === 2) return { status: "forbidden" };
    if (status === 3) return { status: "ok", answer: null };

    const answer = JSON.parse(result[1] ?? "") as SdpPayload;
    return { status: "ok", answer };
  }

  async remove(code: string, tokenHash: string): Promise<DeleteOutcome> {
    const result = await this.redis.eval<[string], number>(
      DELETE_SCRIPT,
      [roomKey(code)],
      [tokenHash],
    );

    switch (Number(result)) {
      case 1:
        return { status: "ok" };
      case 2:
        return { status: "forbidden" };
      default:
        return { status: "not_found" };
    }
  }
}
