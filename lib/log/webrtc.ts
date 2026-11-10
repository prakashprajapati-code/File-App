import type { CandidateReport } from "@/lib/rtc/candidates";
import { isMdnsAddress, parseCandidateLine } from "@/lib/rtc/candidates";
import type { Logger } from "./logger";
import { maskAddress } from "./redact";

export interface CandidateSummary {
  type: string;
  protocol: string;
  address: string;
  port: number | null;
  mdns: boolean;
  networkType: string | null;
}

export interface SelectedPairSummary {
  state: string;
  nominated: boolean;
  roundTripTimeMs: number | null;
  bytesSent: number | null;
  bytesReceived: number | null;
  local: CandidateSummary | null;
  remote: CandidateSummary | null;
}

export interface PeerSnapshot {
  signalingState: string;
  iceGatheringState: string;
  iceConnectionState: string;
  connectionState: string;
  channels: Array<{ label: string; readyState: string }>;
  localCandidateCount: number;
  remoteCandidateCount: number;
  localCandidates: CandidateSummary[];
  remoteCandidates: CandidateSummary[];
  selectedPair: SelectedPairSummary | null;
  dtlsState: string | null;
}

export interface FailureExplanation {
  title: string;
  message: string;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function secondsToMs(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000);
}

/**
 * Records every ICE / signalling state transition and candidate as it happens.
 * Returns a cleanup function for the effect.
 */
export function trackPeerConnection(pc: RTCPeerConnection, log: Logger): () => void {
  const onIceCandidate = (event: RTCPeerConnectionIceEvent): void => {
    if (!event.candidate || !event.candidate.candidate) {
      log.info("ice:candidate:end");
      return;
    }

    const parsed = parseCandidateLine(event.candidate.candidate);
    if (!parsed) {
      log.warn("ice:candidate:unparsed", { candidate: event.candidate.candidate });
      return;
    }

    log.info("ice:candidate", {
      type: parsed.type,
      protocol: parsed.transport,
      address: maskAddress(parsed.address),
      port: parsed.port,
      mdns: isMdnsAddress(parsed.address),
    });
  };

  const onIceCandidateError = (event: RTCPeerConnectionIceErrorEvent): void => {
    log.error("ice:candidate:error", {
      code: event.errorCode,
      text: event.errorText,
      url: event.url,
      address: event.address,
      port: event.port,
    });
  };

  const onGatheringStateChange = (): void => {
    log.info("ice:gathering-state", { state: pc.iceGatheringState });
  };

  const onIceConnectionStateChange = (): void => {
    log.info("ice:connection-state", { state: pc.iceConnectionState });
  };

  const onConnectionStateChange = (): void => {
    log.info("pc:connection-state", { state: pc.connectionState });
  };

  const onSignalingStateChange = (): void => {
    log.info("pc:signaling-state", { state: pc.signalingState });
  };

  const onNegotiationNeeded = (): void => {
    log.debug("pc:negotiation-needed");
  };

  pc.addEventListener("icecandidate", onIceCandidate);
  pc.addEventListener("icecandidateerror", onIceCandidateError);
  pc.addEventListener("icegatheringstatechange", onGatheringStateChange);
  pc.addEventListener("iceconnectionstatechange", onIceConnectionStateChange);
  pc.addEventListener("connectionstatechange", onConnectionStateChange);
  pc.addEventListener("signalingstatechange", onSignalingStateChange);
  pc.addEventListener("negotiationneeded", onNegotiationNeeded);

  return () => {
    pc.removeEventListener("icecandidate", onIceCandidate);
    pc.removeEventListener("icecandidateerror", onIceCandidateError);
    pc.removeEventListener("icegatheringstatechange", onGatheringStateChange);
    pc.removeEventListener("iceconnectionstatechange", onIceConnectionStateChange);
    pc.removeEventListener("connectionstatechange", onConnectionStateChange);
    pc.removeEventListener("signalingstatechange", onSignalingStateChange);
    pc.removeEventListener("negotiationneeded", onNegotiationNeeded);
  };
}

function toCandidateSummary(stat: Record<string, unknown>): CandidateSummary | null {
  const address = readString(stat.address) ?? readString(stat.ip);
  if (!address) return null;

  return {
    type: readString(stat.candidateType) ?? "unknown",
    protocol: readString(stat.protocol) ?? "unknown",
    address: maskAddress(address),
    port: readNumber(stat.port),
    mdns: isMdnsAddress(address),
    networkType: readString(stat.networkType),
  };
}

function toSelectedPair(
  stat: Record<string, unknown>,
  locals: Map<string, CandidateSummary>,
  remotes: Map<string, CandidateSummary>,
): SelectedPairSummary {
  const localId = readString(stat.localCandidateId);
  const remoteId = readString(stat.remoteCandidateId);

  return {
    state: readString(stat.state) ?? "unknown",
    nominated: readBoolean(stat.nominated) === true,
    roundTripTimeMs: secondsToMs(readNumber(stat.currentRoundTripTime)),
    bytesSent: readNumber(stat.bytesSent),
    bytesReceived: readNumber(stat.bytesReceived),
    local: localId ? (locals.get(localId) ?? null) : null,
    remote: remoteId ? (remotes.get(remoteId) ?? null) : null,
  };
}

/**
 * `pc.getStats()` summary: which candidates each side has and whether a pair
 * actually succeeded. This is the part that answers "why did it not connect".
 */
export async function snapshotPeer(
  pc: RTCPeerConnection,
  channels: readonly RTCDataChannel[] = [],
): Promise<PeerSnapshot | null> {
  const base: PeerSnapshot = {
    signalingState: pc.signalingState,
    iceGatheringState: pc.iceGatheringState,
    iceConnectionState: pc.iceConnectionState,
    connectionState: pc.connectionState,
    channels: channels.map((channel) => ({
      label: channel.label,
      readyState: channel.readyState,
    })),
    localCandidateCount: 0,
    remoteCandidateCount: 0,
    localCandidates: [],
    remoteCandidates: [],
    selectedPair: null,
    dtlsState: null,
  };

  let report: RTCStatsReport;
  try {
    report = await pc.getStats();
  } catch {
    return base;
  }

  const locals = new Map<string, CandidateSummary>();
  const remotes = new Map<string, CandidateSummary>();
  const pairs: Array<{ stat: Record<string, unknown>; nominated: boolean }> = [];
  let dtlsState: string | null = null;

  report.forEach((value) => {
    const stat = value as unknown as Record<string, unknown>;
    const type = readString(stat.type) ?? "";
    const id = readString(stat.id) ?? "";

    if (type === "local-candidate" || type === "remote-candidate") {
      const summary = toCandidateSummary(stat);
      if (!summary) return;
      if (type === "local-candidate") locals.set(id, summary);
      else remotes.set(id, summary);
      return;
    }

    if (type === "transport") {
      dtlsState = readString(stat.dtlsState) ?? dtlsState;
      return;
    }

    if (type === "candidate-pair" && readString(stat.state) === "succeeded") {
      pairs.push({ stat, nominated: readBoolean(stat.nominated) === true });
    }
  });

  const selected = pairs.find((pair) => pair.nominated) ?? pairs[0];

  return {
    ...base,
    localCandidateCount: locals.size,
    remoteCandidateCount: remotes.size,
    localCandidates: [...locals.values()].slice(0, 10),
    remoteCandidates: [...remotes.values()].slice(0, 10),
    selectedPair: selected ? toSelectedPair(selected.stat, locals, remotes) : null,
    dtlsState,
  };
}

/**
 * Turns the candidate reports and peer snapshot into a sentence that names the
 * actual problem instead of "check that both devices are on the same Wi-Fi".
 */
export function explainConnectionFailure(input: {
  snapshot: PeerSnapshot | null;
  local: CandidateReport | null;
  remote: CandidateReport | null;
}): FailureExplanation {
  const { snapshot, local, remote } = input;

  if (local && local.verdict === "none") {
    return {
      title: "No network address",
      message:
        "This device could not create a local network address. Turn Wi-Fi off and on again, then retry.",
    };
  }

  if (local?.verdict === "mdns-only" || remote?.verdict === "mdns-only") {
    return {
      title: "Hidden network address",
      message:
        "Both devices only offered hidden mDNS (.local) addresses, which phone hotspots often block. On the phone, open Advanced and enter the TV's IP address from Settings → Network.",
    };
  }

  if (snapshot?.iceConnectionState === "failed") {
    return {
      title: "Connection blocked",
      message:
        "Both devices have a local address but the network refused the connection. This is usually hotspot client isolation.",
    };
  }

  if (snapshot?.connectionState === "connected") {
    return {
      title: "Data channel did not open",
      message:
        "The network connection succeeded but the file channel never opened. Try again, and send the log if it repeats.",
    };
  }

  return {
    title: "Could not connect",
    message:
      "The devices never found a common network path. Both must be on the same Wi-Fi or hotspot, and the hotspot must allow devices to see each other.",
  };
}
