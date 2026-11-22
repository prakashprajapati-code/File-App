/**
 * Wire contract shared by the browser and the room API. Keep this module free
 * of `server-only` imports so both sides can use the same shapes.
 */

export type IceSide = "tv" | "phone";

export interface IceCandidatePayload {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

export interface PostCandidatesResult {
  accepted: number;
  duplicate: number;
  dropped: number;
  total: number;
  complete: boolean;
}

export interface GetCandidatesResult {
  candidates: IceCandidatePayload[];
  next: number;
  total: number;
  complete: boolean;
}
