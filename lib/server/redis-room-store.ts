import "server-only";
import type { Redis } from "@upstash/redis";
import { MAX_ICE_CANDIDATES } from "@/lib/rooms/config";
import type {
  ClaimOutcome,
  DeleteOutcome,
  GetAnswerOutcome,
  GetCandidatesOutcome,
  PostAnswerOutcome,
  PostCandidatesOutcome,
  RoomStore,
} from "./room-store";
import type { IceCandidatePayload, IceSide, RoomRecord, SdpPayload } from "./rooms";

/**
 * Claims a room in one round trip. The room TTL is never extended by a claim.
 * Re-claiming with the same token hash returns the room again (idempotent).
 * Returns: 0 = not found, 1 = claimed/reclaimed (payload = room JSON), 2 = already claimed.
 */
const CLAIM_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {0}
end
local room = cjson.decode(raw)
if room.claimed then
  if room.claimTokenHash == ARGV[1] then
    return {1, raw}
  end
  return {2}
end
room.claimed = true
room.claimTokenHash = ARGV[1]
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 1 then
  return {0}
end
redis.call('SET', KEYS[1], cjson.encode(room), 'PX', ttl)
return {1, cjson.encode(room)}
`;

/**
 * Stores the answer only if the caller holds the claim token. Re-posting the
 * exact same answer is a success so a lost HTTP response can be retried.
 * Returns: 0 = not found, 1 = ok, 2 = not claimed, 3 = forbidden, 4 = answer exists.
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
  local incoming = cjson.decode(ARGV[2])
  if room.answer.sdp == incoming.sdp and room.answer.type == incoming.type then
    return 1
  end
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

/**
 * Appends one side's candidates atomically, deduplicating and capping at
 * MAX (ARGV[5]). The room TTL is preserved, never extended.
 * Returns: 0 = not found, 1 = ok (accepted, duplicate, dropped, total, complete),
 * 2 = forbidden.
 */
const POST_CANDIDATES_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {0}
end
local room = cjson.decode(raw)
local role = ARGV[1]
if role == 'tv' then
  if room.tokenHash ~= ARGV[2] then
    return {2}
  end
else
  if not room.claimed or room.claimTokenHash ~= ARGV[2] then
    return {2}
  end
end
if type(room.ice) ~= 'table' then
  room.ice = { tv = {}, phone = {}, tvComplete = false, phoneComplete = false }
end
if type(room.ice.tv) ~= 'table' then room.ice.tv = {} end
if type(room.ice.phone) ~= 'table' then room.ice.phone = {} end
local list
if role == 'tv' then list = room.ice.tv else list = room.ice.phone end

local function key_of(c)
  local mid = ''
  if type(c.sdpMid) == 'string' then mid = c.sdpMid end
  local idx = ''
  if type(c.sdpMLineIndex) == 'number' then idx = tostring(c.sdpMLineIndex) end
  return mid .. '|' .. idx .. '|' .. c.candidate
end

local seen = {}
for _, c in ipairs(list) do
  seen[key_of(c)] = true
end

local incoming = cjson.decode(ARGV[3])
local accepted = 0
local duplicate = 0
local dropped = 0
local cap = tonumber(ARGV[5]) or 50

for _, c in ipairs(incoming) do
  local k = key_of(c)
  if seen[k] then
    duplicate = duplicate + 1
  elseif #list >= cap then
    dropped = dropped + 1
  else
    list[#list + 1] = c
    seen[k] = true
    accepted = accepted + 1
  end
end

if ARGV[4] == '1' then
  if role == 'tv' then room.ice.tvComplete = true else room.ice.phoneComplete = true end
end

local ttl = redis.call('PTTL', KEYS[1])
if ttl < 1 then
  return {0}
end
redis.call('SET', KEYS[1], cjson.encode(room), 'PX', ttl)

local complete = false
if role == 'tv' then complete = room.ice.tvComplete == true else complete = room.ice.phoneComplete == true end
return {1, accepted, duplicate, dropped, #list, complete and 1 or 0}
`;

/**
 * Returns the other side's candidates from `since` (0-based cursor).
 * Returns: 0 = not found, 1 = ok (json array, total, complete), 2 = forbidden.
 */
const GET_CANDIDATES_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {0}
end
local room = cjson.decode(raw)
local role = ARGV[1]
if role == 'tv' then
  if room.tokenHash ~= ARGV[2] then
    return {2}
  end
else
  if not room.claimed or room.claimTokenHash ~= ARGV[2] then
    return {2}
  end
end
if type(room.ice) ~= 'table' then
  room.ice = { tv = {}, phone = {}, tvComplete = false, phoneComplete = false }
end
if type(room.ice.tv) ~= 'table' then room.ice.tv = {} end
if type(room.ice.phone) ~= 'table' then room.ice.phone = {} end

local list
local complete
if role == 'tv' then
  list = room.ice.phone
  complete = room.ice.phoneComplete == true
else
  list = room.ice.tv
  complete = room.ice.tvComplete == true
end

local since = tonumber(ARGV[3]) or 0
if since < 0 then since = 0 end
if since > #list then since = #list end

local out = {}
for i = since + 1, #list do
  out[#out + 1] = list[i]
end
return {1, cjson.encode(out), #list, complete and 1 or 0}
`;

function roomKey(code: string): string {
  return `room:${code}`;
}

/**
 * Upstash auto-deserializes JSON strings inside `eval` results, while other
 * Redis clients return raw strings. Accept both shapes.
 */
function parseJsonValue<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function parseCandidateList(value: unknown): IceCandidatePayload[] {
  const parsed = parseJsonValue<unknown>(value);
  return Array.isArray(parsed) ? (parsed as IceCandidatePayload[]) : [];
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

    if (result[1] == null) throw new Error("Missing room payload.");
    const record = parseJsonValue<RoomRecord>(result[1]);
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

    if (result[1] == null) throw new Error("Missing answer payload.");
    const answer = parseJsonValue<SdpPayload>(result[1]);
    return { status: "ok", answer };
  }

  async postCandidates(
    code: string,
    role: IceSide,
    tokenHash: string,
    candidates: IceCandidatePayload[],
    complete: boolean,
  ): Promise<PostCandidatesOutcome> {
    const result = await this.redis.eval<[string, string, string, string, string], number[]>(
      POST_CANDIDATES_SCRIPT,
      [roomKey(code)],
      [role, tokenHash, JSON.stringify(candidates), complete ? "1" : "0", String(MAX_ICE_CANDIDATES)],
    );

    const status = Number(result[0]);
    if (status === 0) return { status: "not_found" };
    if (status === 2) return { status: "forbidden" };

    return {
      status: "ok",
      accepted: Number(result[1] ?? 0),
      duplicate: Number(result[2] ?? 0),
      dropped: Number(result[3] ?? 0),
      total: Number(result[4] ?? 0),
      complete: Number(result[5] ?? 0) === 1,
    };
  }

  async getCandidates(
    code: string,
    role: IceSide,
    tokenHash: string,
    since: number,
  ): Promise<GetCandidatesOutcome> {
    const result = await this.redis.eval<[string, string, string], [number, string?, number?, number?]>(
      GET_CANDIDATES_SCRIPT,
      [roomKey(code)],
      [role, tokenHash, String(since)],
    );

    const status = Number(result[0]);
    if (status === 0) return { status: "not_found" };
    if (status === 2) return { status: "forbidden" };

    return {
      status: "ok",
      candidates: parseCandidateList(result[1]),
      next: Number(result[2] ?? 0),
      total: Number(result[2] ?? 0),
      complete: Number(result[3] ?? 0) === 1,
    };
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
