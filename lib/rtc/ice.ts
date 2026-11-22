import type { IceCandidatePayload } from "@/lib/rooms/contract";

/** Normalizes an `RTCIceCandidate` / init into the wire shape. */
export function toTrickleCandidate(
  value: RTCIceCandidateInit | RTCIceCandidate | null | undefined,
): IceCandidatePayload | null {
  if (!value) return null;

  const candidateWithJson = value as RTCIceCandidate;
  const source: RTCIceCandidateInit =
    typeof candidateWithJson.toJSON === "function" ? candidateWithJson.toJSON() : value;

  const candidate = typeof source.candidate === "string" ? source.candidate.trim() : "";
  if (!candidate) return null;

  return {
    candidate,
    sdpMid: typeof source.sdpMid === "string" ? source.sdpMid : null,
    sdpMLineIndex: typeof source.sdpMLineIndex === "number" ? source.sdpMLineIndex : null,
    usernameFragment:
      typeof source.usernameFragment === "string" ? source.usernameFragment : null,
  };
}

/**
 * Duplicate key. `sdpMid`/`sdpMLineIndex` are both included because some
 * browsers omit the mid while others omit the index.
 */
export function iceCandidateKey(candidate: IceCandidatePayload): string {
  const mid = candidate.sdpMid ?? "";
  const index = candidate.sdpMLineIndex === null ? "" : String(candidate.sdpMLineIndex);
  return `${mid}|${index}|${candidate.candidate}`;
}

/** Deduplicating queue used before `setRemoteDescription` completes. */
export class CandidateQueue {
  private items: IceCandidatePayload[] = [];
  private readonly seen = new Set<string>();

  push(candidates: readonly IceCandidatePayload[]): { added: number; duplicate: number } {
    let added = 0;
    let duplicate = 0;

    for (const candidate of candidates) {
      const key = iceCandidateKey(candidate);
      if (this.seen.has(key)) {
        duplicate += 1;
        continue;
      }
      this.seen.add(key);
      this.items.push(candidate);
      added += 1;
    }

    return { added, duplicate };
  }

  /** Removes and returns everything currently queued. */
  drain(): IceCandidatePayload[] {
    const drained = this.items;
    this.items = [];
    this.seen.clear();
    return drained;
  }

  get size(): number {
    return this.items.length;
  }
}
