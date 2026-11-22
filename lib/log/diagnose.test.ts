import { describe, expect, it } from "vitest";
import { buildDiagnosticReport, compareCandidateSubnets } from "./diagnose";
import type { DiagnosticInput } from "./diagnose";
import { countCandidateSummaries } from "./webrtc";
import type {
  CandidateCounts,
  CandidatePairSummary,
  CandidateSummary,
  PeerSnapshot,
} from "./webrtc";

function counts(overrides: Partial<CandidateCounts> = {}): CandidateCounts {
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
    ...overrides,
  };
}

function candidate(address: string, overrides: Partial<CandidateSummary> = {}): CandidateSummary {
  return {
    type: "host",
    protocol: "udp",
    address,
    port: 50_000,
    mdns: address.endsWith(".local"),
    networkType: null,
    ...overrides,
  };
}

function pair(overrides: Partial<CandidatePairSummary> = {}): CandidatePairSummary {
  return {
    state: "succeeded",
    nominated: true,
    requestsSent: 1,
    requestsReceived: 1,
    responsesSent: 1,
    responsesReceived: 1,
    roundTripTimeMs: 2,
    totalRoundTripTimeMs: 2,
    bytesSent: 100,
    bytesReceived: 100,
    local: null,
    remote: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PeerSnapshot> = {}): PeerSnapshot {
  return {
    signalingState: "stable",
    iceGatheringState: "complete",
    iceConnectionState: "checking",
    connectionState: "connecting",
    channels: [
      { label: "control", readyState: "connecting" },
      { label: "data", readyState: "connecting" },
    ],
    localCandidateCount: 2,
    remoteCandidateCount: 2,
    localCandidates: [],
    remoteCandidates: [],
    selectedPair: null,
    selectedCandidatePairId: null,
    iceRole: "controlling",
    pairs: [],
    dataChannels: [],
    dtlsState: "new",
    ...overrides,
  };
}

function input(overrides: Partial<DiagnosticInput> = {}): DiagnosticInput {
  return {
    role: "phone",
    phase: "checking",
    local: counts({ total: 2, host: 2, ipv4: 2, gatheringComplete: true }),
    remote: counts({ total: 2, host: 2, ipv4: 2, gatheringComplete: true }),
    remoteComplete: true,
    signalingLost: false,
    states: snapshot(),
    firstError: { event: "test", detail: "synthetic failure" },
    elapsedMs: 20_000,
    trickle: null,
    configuredTurn: 0,
    ...overrides,
  };
}

describe("buildDiagnosticReport", () => {
  it("reports OK when a channel is open and the connection is connected", () => {
    const report = buildDiagnosticReport(
      input({
        states: snapshot({
          connectionState: "connected",
          iceConnectionState: "connected",
          channels: [{ label: "control", readyState: "open" }],
        }),
      }),
    );

    expect(report.case).toBe("OK");
    expect(report.kind).toBe("webrtc-diagnostic");
    expect(report.version).toBe(1);
  });

  it("reports case B when this device gathered no local candidate", () => {
    const report = buildDiagnosticReport(
      input({
        local: counts({ gatheringComplete: true }),
      }),
    );

    expect(report.case).toBe("B");
    expect(report.title).toMatch(/no network address/i);
  });

  it("reports case A when both sides only advertised mDNS candidates", () => {
    const local = counts({ total: 2, host: 2, mdns: 2, gatheringComplete: true });
    const remote = counts({ total: 2, host: 2, mdns: 2, gatheringComplete: true });

    const report = buildDiagnosticReport(
      input({
        local,
        remote,
        states: snapshot({
          localCandidates: [candidate("a1.local"), candidate("a2.local")],
          remoteCandidates: [candidate("b1.local"), candidate("b2.local")],
        }),
      }),
    );

    expect(report.case).toBe("A");
    expect(report.evidence).toContain("local mdns=2/2");
  });

  it("reports case C when no remote candidate arrived", () => {
    const report = buildDiagnosticReport(
      input({
        remote: counts(),
        remoteComplete: false,
      }),
    );

    expect(report.case).toBe("C");
    expect(report.title).toMatch(/never arrived/i);
  });

  it("reports case C when the other side finished gathering with zero candidates", () => {
    const report = buildDiagnosticReport(
      input({
        remote: counts({ gatheringComplete: true }),
        remoteComplete: true,
      }),
    );

    expect(report.case).toBe("C");
    expect(report.title).toMatch(/found no network address/i);
  });

  it("reports case D when the candidates are on different subnets", () => {
    const report = buildDiagnosticReport(
      input({
        local: counts({ total: 1, host: 1, ipv4: 1, gatheringComplete: true }),
        remote: counts({ total: 1, host: 1, ipv4: 1, gatheringComplete: true }),
        states: snapshot({
          localCandidates: [candidate("192.168.x.x")],
          remoteCandidates: [candidate("10.0.x.x")],
          pairs: [pair({ state: "in-progress", nominated: false, requestsSent: 0 })],
        }),
      }),
    );

    expect(report.case).toBe("D");
    expect(report.title).toMatch(/different networks/i);
    expect(report.sameSubnetHint).toBe(false);
  });

  it("reports case D when checks were sent but no response came back", () => {
    const report = buildDiagnosticReport(
      input({
        local: counts({ total: 1, host: 1, ipv4: 1, gatheringComplete: true }),
        remote: counts({ total: 1, host: 1, ipv4: 1, gatheringComplete: true }),
        states: snapshot({
          localCandidates: [candidate("192.168.x.x")],
          remoteCandidates: [candidate("192.168.x.x")],
          pairs: [
            pair({
              state: "failed",
              nominated: false,
              requestsSent: 6,
              requestsReceived: 0,
              responsesSent: 0,
              responsesReceived: 0,
            }),
          ],
        }),
      }),
    );

    expect(report.case).toBe("D");
    expect(report.title).toMatch(/blocked by the network/i);
    expect(report.sameSubnetHint).toBe(true);
  });

  it("reports case D when candidates exist but no pair was hashed out", () => {
    const report = buildDiagnosticReport(
      input({
        local: counts({ total: 1, host: 1, ipv4: 1, gatheringComplete: true }),
        remote: counts({ total: 1, host: 1, ipv4: 1, gatheringComplete: true }),
        states: snapshot({
          localCandidates: [candidate("192.168.x.x")],
          remoteCandidates: [candidate("192.168.x.x")],
          pairs: [
            pair({
              state: "waiting",
              nominated: false,
              requestsSent: 0,
              requestsReceived: 0,
              responsesSent: 0,
              responsesReceived: 0,
            }),
          ],
        }),
      }),
    );

    expect(report.case).toBe("D");
    expect(report.title).toMatch(/no usable network path/i);
  });

  it("reports case E when ICE connected but no channel opened", () => {
    const report = buildDiagnosticReport(
      input({
        states: snapshot({
          connectionState: "connected",
          iceConnectionState: "connected",
          dtlsState: "connected",
          pairs: [pair()],
          selectedPair: pair(),
        }),
      }),
    );

    expect(report.case).toBe("E");
    expect(report.title).toMatch(/data channel failed/i);
  });

  it("reports signaling loss before blaming the network", () => {
    const report = buildDiagnosticReport(
      input({
        signalingLost: true,
        states: snapshot({ localCandidates: [candidate("192.168.x.x")] }),
      }),
    );

    expect(report.case).toBe("UNKNOWN");
    expect(report.title).toMatch(/pairing ended/i);
  });

  it("falls back to UNKNOWN when the evidence is not conclusive", () => {
    const report = buildDiagnosticReport(
      input({
        states: snapshot({
          connectionState: "connecting",
          iceConnectionState: "checking",
          pairs: [pair({ state: "succeeded", nominated: true })],
          localCandidates: [candidate("192.168.x.x")],
          remoteCandidates: [candidate("192.168.x.x")],
        }),
      }),
    );

    expect(report.case).toBe("UNKNOWN");
  });

  it("carries the first error and the elapsed time into the report", () => {
    const report = buildDiagnosticReport(
      input({
        firstError: { event: "connectionstatechange:failed", detail: "ICE failed" },
        elapsedMs: 12_345,
      }),
    );

    expect(report.firstError).toEqual({
      event: "connectionstatechange:failed",
      detail: "ICE failed",
    });
    expect(report.elapsedMs).toBe(12_345);
  });
});

describe("compareCandidateSubnets", () => {
  it("returns true when the masked subnets overlap", () => {
    expect(
      compareCandidateSubnets(
        [candidate("192.168.x.x"), candidate("10.0.x.x")],
        [candidate("192.168.x.x")],
      ),
    ).toBe(true);
  });

  it("returns false when they do not overlap", () => {
    expect(
      compareCandidateSubnets([candidate("192.168.x.x")], [candidate("10.0.x.x")]),
    ).toBe(false);
  });

  it("returns null when either side has no IPv4 candidate", () => {
    expect(compareCandidateSubnets([], [candidate("192.168.x.x")])).toBeNull();
    expect(
      compareCandidateSubnets([candidate("a1.local")], [candidate("192.168.x.x")]),
    ).toBeNull();
  });
});

describe("countCandidateSummaries", () => {
  it("counts types, mDNS and IPv4 addresses", () => {
    const result = countCandidateSummaries(
      [
        candidate("192.168.x.x"),
        candidate("a1b2c3.local"),
        candidate("2001:db8::1", { type: "srflx" }),
      ],
      true,
    );

    expect(result).toMatchObject({
      total: 3,
      host: 2,
      srflx: 1,
      mdns: 1,
      ipv4: 1,
      ipv6: 1,
      gatheringComplete: true,
    });
  });

  it("keeps gathering state false by default", () => {
    expect(countCandidateSummaries([]).gatheringComplete).toBe(false);
  });
});
