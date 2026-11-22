import type { CandidateReport } from "@/lib/rtc/candidates";
import { isMdnsAddress, isValidIPv4, parseCandidateLine } from "@/lib/rtc/candidates";
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

export interface CandidateCounts {
  total: number;
  host: number;
  srflx: number;
  prflx: number;
  relay: number;
  mdns: number;
  ipv4: number;
  ipv6: number;
  gatheringComplete: boolean;
}

export interface CandidatePairSummary {
  state: string;
  nominated: boolean;
  requestsSent: number | null;
  requestsReceived: number | null;
  responsesSent: number | null;
  responsesReceived: number | null;
  roundTripTimeMs: number | null;
  totalRoundTripTimeMs: number | null;
  bytesSent: number | null;
  bytesReceived: number | null;
  local: CandidateSummary | null;
  remote: CandidateSummary | null;
}

export interface DataChannelSummary {
  label: string | null;
  state: string | null;
  messagesSent: number | null;
  messagesReceived: number | null;
  bytesSent: number | null;
  bytesReceived: number | null;
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
  selectedPair: CandidatePairSummary | null;
  selectedCandidatePairId: string | null;
  iceRole: string | null;
  pairs: CandidatePairSummary[];
  dataChannels: DataChannelSummary[];
  dtlsState: string | null;
}

export interface PeerTracker {
  stop(): void;
  counts(): CandidateCounts;
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

export function emptyCandidateCounts(): CandidateCounts {
  return {
    total: 0,
    host: 0,
    srflx: 0,
    prflx: 0,
    relay: 0,
    mdns: 0,
    ipv4: 0,
    ipv6: 0,
    gatheringComplete: false,
  };
}

function addCandidateType(counts: CandidateCounts, type: string): void {
  if (type === "host") counts.host += 1;
  else if (type === "srflx") counts.srflx += 1;
  else if (type === "prflx") counts.prflx += 1;
  else if (type === "relay") counts.relay += 1;
}

/** Converts `getStats()` candidate summaries to the same shape as live events. */
export function countCandidateSummaries(
  candidates: readonly CandidateSummary[],
  gatheringComplete = false,
): CandidateCounts {
  const counts = emptyCandidateCounts();
  counts.gatheringComplete = gatheringComplete;

  for (const candidate of candidates) {
    counts.total += 1;
    addCandidateType(counts, candidate.type);

    if (candidate.mdns || isMdnsAddress(candidate.address)) {
      counts.mdns += 1;
      continue;
    }

    if (candidate.address.includes(":")) counts.ipv6 += 1;
    else if (/^\d{1,3}\.\d{1,3}\./.test(candidate.address)) counts.ipv4 += 1;
  }

  return counts;
}

/**
 * Records every ICE / signalling state transition, candidate and channel event
 * as it happens. Returns a tracker whose counts feed the diagnostic report.
 */
export function trackPeerConnection(pc: RTCPeerConnection, log: Logger): PeerTracker {
  const counts = emptyCandidateCounts();

  const onIceCandidate = (event: RTCPeerConnectionIceEvent): void => {
    if (!event.candidate || !event.candidate.candidate) {
      counts.gatheringComplete = true;
      log.info("ice:candidate:end", { counts: { ...counts } });
      return;
    }

    const parsed = parseCandidateLine(event.candidate.candidate);
    if (!parsed) {
      log.warn("ice:candidate:unparsed", { length: event.candidate.candidate.length });
      return;
    }

    counts.total += 1;
    addCandidateType(counts, parsed.type);
    if (isMdnsAddress(parsed.address)) counts.mdns += 1;
    else if (isValidIPv4(parsed.address)) counts.ipv4 += 1;
    else if (parsed.address.includes(":")) counts.ipv6 += 1;

    log.info("ice:candidate", {
      type: parsed.type,
      protocol: parsed.transport,
      address: maskAddress(parsed.address),
      port: parsed.port,
      mdns: isMdnsAddress(parsed.address),
    });
    log.debug("ice:candidates:summary", { counts: { ...counts } });
  };

  const onIceCandidateError = (event: RTCPeerConnectionIceErrorEvent): void => {
    log.error("ice:candidate:error", {
      code: event.errorCode,
      text: event.errorText,
      url: event.url,
      address: event.address ? maskAddress(event.address) : null,
      port: event.port,
    });
  };

  const onGatheringStateChange = (): void => {
    if (pc.iceGatheringState === "complete") counts.gatheringComplete = true;
    log.info("ice:gathering-state", {
      state: pc.iceGatheringState,
      counts: { ...counts },
    });
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

  return {
    stop: () => {
      pc.removeEventListener("icecandidate", onIceCandidate);
      pc.removeEventListener("icecandidateerror", onIceCandidateError);
      pc.removeEventListener("icegatheringstatechange", onGatheringStateChange);
      pc.removeEventListener("iceconnectionstatechange", onIceConnectionStateChange);
      pc.removeEventListener("connectionstatechange", onConnectionStateChange);
      pc.removeEventListener("signalingstatechange", onSignalingStateChange);
      pc.removeEventListener("negotiationneeded", onNegotiationNeeded);
    },
    counts: () => ({ ...counts }),
  };
}

/** Records when each side's DataChannel opens, closes, errors or starts closing. */
export function trackDataChannel(channel: RTCDataChannel, log: Logger): () => void {
  const label = channel.label;

  const onOpen = (): void => {
    log.info("channel:open", { label, readyState: channel.readyState });
  };
  const onClosing = (): void => {
    log.info("channel:closing", { label, readyState: channel.readyState });
  };
  const onClose = (): void => {
    log.warn("channel:close", { label, readyState: channel.readyState });
  };
  const onError = (event: RTCErrorEvent): void => {
    log.error("channel:error", {
      label,
      readyState: channel.readyState,
      error: event.error?.message ?? null,
    });
  };

  channel.addEventListener("open", onOpen);
  channel.addEventListener("closing", onClosing);
  channel.addEventListener("close", onClose);
  channel.addEventListener("error", onError);

  return () => {
    channel.removeEventListener("open", onOpen);
    channel.removeEventListener("closing", onClosing);
    channel.removeEventListener("close", onClose);
    channel.removeEventListener("error", onError);
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

function toCandidatePairSummary(
  stat: Record<string, unknown>,
  locals: Map<string, CandidateSummary>,
  remotes: Map<string, CandidateSummary>,
): CandidatePairSummary {
  const localId = readString(stat.localCandidateId);
  const remoteId = readString(stat.remoteCandidateId);

  return {
    state: readString(stat.state) ?? "unknown",
    nominated: readBoolean(stat.nominated) === true,
    requestsSent: readNumber(stat.requestsSent),
    requestsReceived: readNumber(stat.requestsReceived),
    responsesSent: readNumber(stat.responsesSent),
    responsesReceived: readNumber(stat.responsesReceived),
    roundTripTimeMs: secondsToMs(readNumber(stat.currentRoundTripTime)),
    totalRoundTripTimeMs: secondsToMs(readNumber(stat.totalRoundTripTime)),
    bytesSent: readNumber(stat.bytesSent),
    bytesReceived: readNumber(stat.bytesReceived),
    local: localId ? (locals.get(localId) ?? null) : null,
    remote: remoteId ? (remotes.get(remoteId) ?? null) : null,
  };
}

function toDataChannelSummary(stat: Record<string, unknown>): DataChannelSummary {
  return {
    label: readString(stat.label),
    state: readString(stat.state) ?? readString(stat.readyState),
    messagesSent: readNumber(stat.messagesSent),
    messagesReceived: readNumber(stat.messagesReceived),
    bytesSent: readNumber(stat.bytesSent),
    bytesReceived: readNumber(stat.bytesReceived),
  };
}

function pairRank(pair: CandidatePairSummary): number {
  if (pair.state === "succeeded") return 0;
  if (pair.state === "in-progress") return 1;
  if (pair.state === "failed") return 2;
  return 3;
}

/** Resolves `getStats()` or null, so a stuck stats call cannot block shutdown. */
function getStatsWithTimeout(
  pc: RTCPeerConnection,
  timeoutMs = 1_000,
): Promise<RTCStatsReport | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (value: RTCStatsReport | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(() => finish(null), timeoutMs);
    pc.getStats().then(
      (value) => finish(value),
      () => finish(null),
    );
  });
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
    selectedCandidatePairId: null,
    iceRole: null,
    pairs: [],
    dataChannels: [],
    dtlsState: null,
  };

  const report = await getStatsWithTimeout(pc);
  if (!report) return base;

  const locals = new Map<string, CandidateSummary>();
  const remotes = new Map<string, CandidateSummary>();
  const pairStats: Array<Record<string, unknown>> = [];
  const dataChannels: DataChannelSummary[] = [];
  let dtlsState: string | null = null;
  let selectedCandidatePairId: string | null = null;
  let iceRole: string | null = null;

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
      selectedCandidatePairId = readString(stat.selectedCandidatePairId) ?? selectedCandidatePairId;
      iceRole = readString(stat.iceRole) ?? iceRole;
      return;
    }

    if (type === "candidate-pair") {
      pairStats.push(stat);
      return;
    }

    if (type === "data-channel") {
      dataChannels.push(toDataChannelSummary(stat));
    }
  });

  const pairs = pairStats.map((stat) => toCandidatePairSummary(stat, locals, remotes));
  pairs.sort((a, b) => {
    const rank = pairRank(a) - pairRank(b);
    if (rank !== 0) return rank;
    return Number(b.nominated) - Number(a.nominated);
  });

  const selectedStat = selectedCandidatePairId
    ? pairStats.find((stat) => readString(stat.id) === selectedCandidatePairId)
    : undefined;
  const succeededStats = pairStats.filter((stat) => readString(stat.state) === "succeeded");
  const nominatedStat = succeededStats.find((stat) => readBoolean(stat.nominated) === true);
  const selectedPairStat = selectedStat ?? nominatedStat ?? succeededStats[0];

  return {
    ...base,
    localCandidateCount: locals.size,
    remoteCandidateCount: remotes.size,
    localCandidates: [...locals.values()].slice(0, 10),
    remoteCandidates: [...remotes.values()].slice(0, 10),
    selectedPair: selectedPairStat
      ? toCandidatePairSummary(selectedPairStat, locals, remotes)
      : null,
    selectedCandidatePairId,
    iceRole,
    pairs,
    dataChannels,
    dtlsState,
  };
}

/**
 * Turns the candidate reports and peer snapshot into a sentence that names the
 * actual problem instead of "check that both devices are on the same Wi-Fi".
 * Kept for the existing UI path; `diagnose.ts` builds the richer report.
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
