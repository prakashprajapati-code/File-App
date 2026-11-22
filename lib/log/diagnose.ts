import type { LogRole } from "./types";
import type {
  CandidateCounts,
  CandidatePairSummary,
  CandidateSummary,
  PeerSnapshot,
} from "./webrtc";
import { countCandidateSummaries, snapshotPeer } from "./webrtc";
import type { TrickleCounts } from "@/lib/rtc/trickle";

export type DiagnosticCase = "A" | "B" | "C" | "D" | "E" | "OK" | "UNKNOWN";

export type DiagnosticPhase =
  | "answer-wait"
  | "remote-description"
  | "checking"
  | "channel-wait"
  | "connected"
  | "closed";

export interface DiagnosticError {
  event: string;
  detail: string;
}

export interface DiagnosticInput {
  role: LogRole;
  phase: DiagnosticPhase;
  local: CandidateCounts;
  remote: CandidateCounts;
  remoteComplete: boolean | null;
  signalingLost: boolean;
  states: PeerSnapshot | null;
  firstError: DiagnosticError | null;
  elapsedMs: number;
  trickle: TrickleCounts | null;
  configuredTurn: number;
}

export interface DiagnosticReport {
  kind: "webrtc-diagnostic";
  version: 1;
  role: LogRole;
  phase: DiagnosticPhase;
  case: DiagnosticCase;
  title: string;
  message: string;
  evidence: string[];
  elapsedMs: number;
  local: CandidateCounts;
  remote: CandidateCounts;
  remoteComplete: boolean | null;
  signalingLost: boolean;
  sameSubnetHint: boolean | null;
  peer: PeerSnapshot | null;
  firstError: DiagnosticError | null;
  trickle: TrickleCounts | null;
  configuredTurn: number;
}

export interface PeerDiagnosticCapture {
  snapshot: PeerSnapshot | null;
  report: DiagnosticReport;
}

function sumMetric(
  pairs: readonly CandidatePairSummary[],
  key: "requestsSent" | "requestsReceived" | "responsesSent" | "responsesReceived",
): number {
  return pairs.reduce((total, pair) => total + (pair[key] ?? 0), 0);
}

/**
 * Compares only the first two IPv4 octets. Candidate summaries are already
 * masked (`192.168.x.x`), which is exactly the subnet hint we need.
 * Returns null when either side has no IPv4 candidate to compare.
 */
export function compareCandidateSubnets(
  local: readonly CandidateSummary[],
  remote: readonly CandidateSummary[],
): boolean | null {
  const subnets = (list: readonly CandidateSummary[]): Set<string> => {
    const result = new Set<string>();
    for (const candidate of list) {
      const match = /^(\d{1,3}\.\d{1,3})\./.exec(candidate.address);
      if (match) result.add(match[1]);
    }
    return result;
  };

  const localSubnets = subnets(local);
  const remoteSubnets = subnets(remote);
  if (localSubnets.size === 0 || remoteSubnets.size === 0) return null;

  for (const subnet of localSubnets) {
    if (remoteSubnets.has(subnet)) return true;
  }
  return false;
}

function buildReport(
  input: DiagnosticInput,
  caseCode: DiagnosticCase,
  title: string,
  message: string,
  evidence: string[],
): DiagnosticReport {
  return {
    kind: "webrtc-diagnostic",
    version: 1,
    role: input.role,
    phase: input.phase,
    case: caseCode,
    title,
    message,
    evidence,
    elapsedMs: input.elapsedMs,
    local: input.local,
    remote: input.remote,
    remoteComplete: input.remoteComplete,
    signalingLost: input.signalingLost,
    sameSubnetHint: compareCandidateSubnets(
      input.states?.localCandidates ?? [],
      input.states?.remoteCandidates ?? [],
    ),
    peer: input.states,
    firstError: input.firstError,
    trickle: input.trickle,
    configuredTurn: input.configuredTurn,
  };
}

/**
 * Classifies the failure from evidence, never from assumptions. The ordering
 * matters: a proven connection wins, then a proven local/remote gap, then
 * candidate set problems, then pair-level network failures.
 */
export function buildDiagnosticReport(input: DiagnosticInput): DiagnosticReport {
  const { states, local, remote, remoteComplete, signalingLost, trickle, configuredTurn } =
    input;
  const pairs = states?.pairs ?? [];
  const succeeded = pairs.filter((pair) => pair.state === "succeeded");
  const openChannel = (states?.channels ?? []).some((channel) => channel.readyState === "open");
  const selected = states?.selectedPair ?? succeeded.find((pair) => pair.nominated) ?? succeeded[0] ?? null;

  const requestsSent = sumMetric(pairs, "requestsSent");
  const requestsReceived = sumMetric(pairs, "requestsReceived");
  const responsesSent = sumMetric(pairs, "responsesSent");
  const responsesReceived = sumMetric(pairs, "responsesReceived");

  const pairEvidence = `pairs=${pairs.length} succeeded=${succeeded.length} requestsSent=${requestsSent} requestsReceived=${requestsReceived} responsesSent=${responsesSent} responsesReceived=${responsesReceived}`;

  if (openChannel && (states?.connectionState === "connected" || states?.iceConnectionState === "connected")) {
    return buildReport(
      input,
      "OK",
      "Connection was established",
      "The peer connection and data channel were open when this report was captured.",
      ["data channel readyState=open", `connectionState=${states?.connectionState ?? "unknown"}`],
    );
  }

  if (
    succeeded.length > 0 &&
    !openChannel &&
    (states?.connectionState === "connected" ||
      states?.iceConnectionState === "connected" ||
      states?.iceConnectionState === "completed" ||
      states?.dtlsState === "connected")
  ) {
    return buildReport(
      input,
      "E",
      "Network works, data channel failed",
      "ICE found a working pair, but the data channel never opened. This is an SCTP/DTLS negotiation problem, not Wi-Fi reachability.",
      [pairEvidence, `dtlsState=${states?.dtlsState ?? "unknown"}`, `selectedPair=${selected?.state ?? "none"}`],
    );
  }

  if (local.total === 0 && (local.gatheringComplete || states?.iceGatheringState === "complete")) {
    return buildReport(
      input,
      "B",
      "No network address on this device",
      "This device finished ICE gathering without a single local candidate, so the other device has nothing to connect to. Turn Wi-Fi off and on again, then retry.",
      ["local candidates=0", "iceGatheringState=complete"],
    );
  }

  if (signalingLost) {
    return buildReport(
      input,
      "UNKNOWN",
      "Pairing ended before ICE finished",
      "The pairing room was deleted or expired while the devices were still exchanging network addresses. Show a new code and retry.",
      ["signalingLost=true", `local=${local.total} remote=${remote.total}`, pairEvidence],
    );
  }

  if (remote.total === 0) {
    if (trickle && trickle.remoteReceived > 0 && trickle.remoteApplied === 0) {
      return buildReport(
        input,
        "C",
        "Remote network addresses could not be used",
        "Candidates arrived from the other device, but none could be added to the peer connection. This is a signaling/ICE state problem rather than Wi-Fi reachability. Retry so both devices exchange a fresh description.",
        [
          `remote received=${trickle.remoteReceived} applied=${trickle.remoteApplied} queued=${trickle.remoteQueued}`,
          `applyFailures=${trickle.applyFailures}`,
          `remote candidates=${remote.total}`,
          `local=${local.total}`,
        ],
      );
    }

    if (remoteComplete === true) {
      return buildReport(
        input,
        "C",
        "The other device found no network address",
        "The other device finished gathering without a single ICE candidate. Retry on that device and check its Wi-Fi.",
        ["remote candidates=0", "remoteComplete=true", `local=${local.total}`],
      );
    }

    return buildReport(
      input,
      "C",
      "The other device's network address never arrived",
      "No remote ICE candidate was visible to this device, so no connectivity check could be sent. The pairing channel either did not deliver them or the other device still had nothing to send.",
      [
        "remote candidates=0",
        `remoteComplete=${remoteComplete === null ? "unknown" : "false"}`,
        `local=${local.total}`,
        `trickle localSent=${trickle?.localSent ?? 0} remoteReceived=${trickle?.remoteReceived ?? 0} pollFailures=${trickle?.pollFailures ?? 0}`,
      ],
    );
  }

  // Only claim "mDNS only" with gathering evidence. A candidate count taken
  // before gathering finishes can look mDNS-only simply because nothing else
  // has arrived yet.
  const localGatheringDone =
    local.gatheringComplete || states?.iceGatheringState === "complete";
  const localMdnsOnly = local.total > 0 && local.mdns === local.total && localGatheringDone;
  const remoteMdnsOnly = remote.total > 0 && remote.mdns === remote.total && remoteComplete === true;

  if ((localMdnsOnly || remoteMdnsOnly) && succeeded.length === 0) {
    const title = "Hidden network address";
    const message =
      localMdnsOnly && remoteMdnsOnly
        ? "Both devices only advertised mDNS (.local) addresses. Phone hotspots often block multicast resolution. Use the TV's IP fallback or a normal Wi-Fi router."
        : localMdnsOnly
          ? "This device only advertised mDNS (.local) addresses. If the hotspot blocks multicast, the other device can never resolve them. Use the TV's IP fallback or a normal Wi-Fi router."
          : "The other device only advertised mDNS (.local) addresses. If the hotspot blocks multicast, this device can never resolve them. Use the TV's IP fallback or a normal Wi-Fi router.";

    return buildReport(input, "A", title, message, [
      `local mdns=${local.mdns}/${local.total} gatheringComplete=${localGatheringDone}`,
      `remote mdns=${remote.mdns}/${remote.total} remoteComplete=${remoteComplete === true}`,
      `mdns side=${localMdnsOnly && remoteMdnsOnly ? "both" : localMdnsOnly ? "local" : "remote"}`,
      pairEvidence,
    ]);
  }

  if (local.total > 0 && remote.total > 0 && succeeded.length === 0) {
    const sameSubnet = compareCandidateSubnets(
      states?.localCandidates ?? [],
      states?.remoteCandidates ?? [],
    );

    const turnUnavailable =
      configuredTurn > 0 &&
      local.relay === 0 &&
      (sameSubnet === false || (requestsSent > 0 && responsesReceived === 0));

    if (turnUnavailable) {
      return buildReport(
        input,
        "D",
        "TURN relay was not available",
        "TURN is configured, but no relay candidate was allocated, so there is no fallback path around the blocked network. Check the TURN URL, credentials and reachability, or connect both devices to the same router.",
        [
          `configuredTurnServers=${configuredTurn}`,
          `local relay=${local.relay} srflx=${local.srflx}`,
          `sameSubnetHint=${sameSubnet === null ? "unknown" : String(sameSubnet)}`,
          pairEvidence,
        ],
      );
    }

    if (sameSubnet === false) {
      return buildReport(
        input,
        "D",
        "Devices are on different networks",
        "The local and remote candidate addresses are on different subnets. Connect both devices to the same router or hotspot.",
        [`local=${local.total} remote=${remote.total}`, "sameSubnetHint=false", pairEvidence],
      );
    }

    if (requestsSent > 0 && responsesReceived === 0) {
      return buildReport(
        input,
        "D",
        "Connection blocked by the network",
        "Connectivity checks were sent but nothing came back. This is usually hotspot client isolation, an AP that blocks device-to-device traffic, or a candidate the other side cannot route to.",
        [pairEvidence, `sameSubnetHint=${sameSubnet === null ? "unknown" : String(sameSubnet)}`],
      );
    }

    return buildReport(
      input,
      "D",
      "No usable network path",
      "Both devices have candidates, but ICE did not nominate a working pair. The pair counters in this report show whether checks were sent and answered.",
      [pairEvidence, `sameSubnetHint=${sameSubnet === null ? "unknown" : String(sameSubnet)}`],
    );
  }

  return buildReport(
    input,
    "UNKNOWN",
    "Could not determine the cause",
    "Not enough ICE evidence was captured to classify the failure. Retry and send this report.",
    [
      `local=${local.total} remote=${remote.total}`,
      `iceConnectionState=${states?.iceConnectionState ?? "unknown"}`,
      pairEvidence,
    ],
  );
}

/**
 * Captures `getStats()` first, then builds the report. Call this BEFORE closing
 * the peer connection; a closed peer yields an empty snapshot.
 */
export async function capturePeerDiagnostics(input: {
  role: LogRole;
  phase: DiagnosticPhase;
  pc: RTCPeerConnection;
  channels?: readonly RTCDataChannel[];
  local: CandidateCounts;
  remoteComplete?: boolean | null;
  signalingLost?: boolean;
  firstError?: DiagnosticError | null;
  elapsedMs: number;
  trickle?: TrickleCounts | null;
  configuredTurn?: number;
}): Promise<PeerDiagnosticCapture> {
  const snapshot = await snapshotPeer(input.pc, input.channels ?? []);
  const remote = countCandidateSummaries(
    snapshot?.remoteCandidates ?? [],
    input.remoteComplete ?? input.trickle?.remoteComplete ?? false,
  );

  const report = buildDiagnosticReport({
    role: input.role,
    phase: input.phase,
    local: input.local,
    remote,
    remoteComplete: input.remoteComplete ?? input.trickle?.remoteComplete ?? null,
    signalingLost: input.signalingLost ?? false,
    states: snapshot,
    firstError: input.firstError ?? null,
    elapsedMs: input.elapsedMs,
    trickle: input.trickle ?? null,
    configuredTurn: input.configuredTurn ?? 0,
  });

  return { snapshot, report };
}
