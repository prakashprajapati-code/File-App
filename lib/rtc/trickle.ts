import type { Logger } from "@/lib/log/logger";
import type {
  GetCandidatesResult,
  IceCandidatePayload,
  PostCandidatesResult,
} from "@/lib/rooms/contract";
import { CANDIDATE_POLL_MS } from "@/lib/rooms/config";
import { CandidateQueue, iceCandidateKey, toTrickleCandidate } from "./ice";

export interface TrickleCounts {
  localCaptured: number;
  localSent: number;
  localComplete: boolean;
  remoteReceived: number;
  remoteApplied: number;
  remoteComplete: boolean;
  remoteQueued: number;
  duplicatesIgnored: number;
  sendFailures: number;
  pollFailures: number;
  applyFailures: number;
  signalingLost: boolean;
}

export interface TrickleTransport {
  post(candidates: IceCandidatePayload[], complete: boolean): Promise<PostCandidatesResult>;
  get(since: number): Promise<GetCandidatesResult>;
}

export interface TrickleOptions {
  pc: RTCPeerConnection;
  log: Logger;
  transport: TrickleTransport;
  pollMs?: number;
  maxBatch?: number;
  retryDelayMs?: number;
}

export interface IceTrickle {
  /** Attach before `setLocalDescription` so no candidate is missed. */
  capture(): void;
  /** Begin posting buffered candidates. Call once the room/token exists. */
  start(): void;
  /** Flush queued remote candidates. Call after `setRemoteDescription`. */
  applyRemote(): Promise<void>;
  /** Begin polling. Safe to call before `setRemoteDescription`; candidates queue. */
  pollRemote(): void;
  stop(): void;
  counts(): TrickleCounts;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function readStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/**
 * Trickle ICE over the room mailbox.
 *
 * The important ordering guarantees:
 *  - local candidates are captured before the SDP is created;
 *  - remote candidates are queued until `setRemoteDescription` has resolved;
 *  - end-of-candidates is only sent after every buffered candidate.
 */
export function createIceTrickle(options: TrickleOptions): IceTrickle {
  const { pc, log, transport } = options;
  const pollMs = options.pollMs ?? CANDIDATE_POLL_MS;
  const maxBatch = options.maxBatch ?? 10;
  const retryDelayMs = options.retryDelayMs ?? 1_500;

  const counts: TrickleCounts = {
    localCaptured: 0,
    localSent: 0,
    localComplete: false,
    remoteReceived: 0,
    remoteApplied: 0,
    remoteComplete: false,
    remoteQueued: 0,
    duplicatesIgnored: 0,
    sendFailures: 0,
    pollFailures: 0,
    applyFailures: 0,
    signalingLost: false,
  };

  const localSeen = new Set<string>();
  const remoteQueue = new CandidateQueue();

  let capturing = false;
  let started = false;
  let stopped = false;
  let posting = false;
  let retryBlocked = false;
  let localEnded = false;
  let completeSent = false;
  let outbox: IceCandidatePayload[] = [];

  let since = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pollStopped = false;
  let completeTicks = 0;
  let remoteDescriptionReady = false;
  let applying = false;

  const scheduleRetry = (): void => {
    if (stopped || retryTimer) return;
    retryBlocked = true;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryBlocked = false;
      void flushLocal();
    }, retryDelayMs);
  };

  const flushLocal = async (): Promise<void> => {
    if (!started || stopped || posting || retryBlocked) return;
    posting = true;

    try {
      while (!stopped) {
        if (outbox.length === 0) {
          if (localEnded && !completeSent) {
            try {
              await transport.post([], true);
              completeSent = true;
              counts.localComplete = true;
              log.info("trickle:local-complete");
            } catch (error) {
              counts.sendFailures += 1;
              log.warn("trickle:complete-failed", { name: errorName(error) });
              scheduleRetry();
            }
          }
          break;
        }

        const batch = outbox.slice(0, maxBatch);
        try {
          await transport.post(batch, false);
          outbox = outbox.slice(batch.length);
          counts.localSent += batch.length;
        } catch (error) {
          counts.sendFailures += 1;
          log.warn("trickle:send-failed", { batch: batch.length, name: errorName(error) });
          scheduleRetry();
          break;
        }
      }
    } finally {
      posting = false;
    }

    if (!stopped && !retryBlocked && (outbox.length > 0 || (localEnded && !completeSent))) {
      void flushLocal();
    }
  };

  const applyRemote = async (): Promise<void> => {
    if (stopped) return;
    remoteDescriptionReady = true;
    if (applying) return;

    applying = true;
    try {
      while (!stopped) {
        const batch = remoteQueue.drain();
        counts.remoteQueued = 0;
        if (batch.length === 0) break;

        for (let index = 0; index < batch.length; index += 1) {
          try {
            await pc.addIceCandidate(batch[index]);
            counts.remoteApplied += 1;
          } catch (error) {
            const name = errorName(error);

            // Remote description not applied yet: keep the candidate for the
            // next flush instead of dropping it.
            if (name === "InvalidStateError") {
              const remaining = batch.slice(index);
              remoteQueue.push(remaining);
              counts.remoteQueued = remoteQueue.size;
              log.debug("trickle:apply-deferred", { remaining: remaining.length });
              return;
            }

            counts.applyFailures += 1;
            log.warn("trickle:apply-failed", { name });
          }
        }
      }
    } finally {
      applying = false;
    }
  };

  const pollOnce = async (): Promise<void> => {
    if (stopped || pollStopped) return;
    pollTimer = null;

    try {
      const result = await transport.get(since);
      since = result.next;

      const { added, duplicate } = remoteQueue.push(result.candidates);
      counts.remoteReceived += added;
      counts.duplicatesIgnored += duplicate;
      counts.remoteQueued = remoteQueue.size;
      counts.remoteComplete = result.complete;

      if (result.complete) {
        completeTicks += 1;
        log.info("trickle:remote-complete", { total: result.total });
      }

      if (remoteDescriptionReady && remoteQueue.size > 0) {
        await applyRemote();
      }
    } catch (error) {
      const status = readStatus(error);
      if (status === 404 || status === 403) {
        counts.signalingLost = true;
        pollStopped = true;
        log.warn("trickle:signaling-lost", { status });
        return;
      }

      counts.pollFailures += 1;
      log.debug("trickle:poll-failed", { status });
    } finally {
      // One extra tick after end-of-candidates catches anything posted late.
      if (counts.remoteComplete && completeTicks >= 2) {
        pollStopped = true;
      }

      if (!stopped && !pollStopped) {
        pollTimer = setTimeout(() => void pollOnce(), pollMs);
      }
    }
  };

  const onIceCandidate = (event: RTCPeerConnectionIceEvent): void => {
    if (stopped) return;

    if (!event.candidate || !event.candidate.candidate) {
      if (localEnded) return;
      localEnded = true;
      log.info("trickle:local-end", { captured: counts.localCaptured });
      void flushLocal();
      return;
    }

    const candidate = toTrickleCandidate(event.candidate);
    if (!candidate) return;

    const key = iceCandidateKey(candidate);
    if (localSeen.has(key)) return;
    localSeen.add(key);

    counts.localCaptured += 1;
    outbox.push(candidate);
    void flushLocal();
  };

  return {
    capture: () => {
      if (capturing || stopped) return;
      capturing = true;
      pc.addEventListener("icecandidate", onIceCandidate);
      log.info("trickle:capture");
    },
    start: () => {
      if (started || stopped) return;
      started = true;
      log.info("trickle:start");
      void flushLocal();
    },
    applyRemote,
    pollRemote: () => {
      if (stopped || pollStopped || pollTimer) return;
      log.info("trickle:poll-start");
      void pollOnce();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (capturing) pc.removeEventListener("icecandidate", onIceCandidate);
      if (pollTimer) clearTimeout(pollTimer);
      if (retryTimer) clearTimeout(retryTimer);
      pollTimer = null;
      retryTimer = null;
      counts.remoteQueued = remoteQueue.size;
      log.info("trickle:stop", { counts: { ...counts } });
    },
    counts: () => ({ ...counts, remoteQueued: remoteQueue.size }),
  };
}
