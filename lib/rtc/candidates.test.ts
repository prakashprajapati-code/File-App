import { describe, expect, it } from "vitest";
import {
  analyzeSdp,
  isMdnsAddress,
  isValidIPv4,
  parseCandidateLine,
  rewriteMdnsCandidates,
} from "./candidates";

const mdnsSdp = [
  "v=0",
  "o=- 1 1 IN IP4 127.0.0.1",
  "a=ice-ufrag:abcd",
  "a=ice-pwd:secret",
  "a=fingerprint:sha-256 AA:BB:CC:DD",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "a=candidate:1 1 udp 2122260223 8a1b2c3d-1234-5678-9abc-def012345678.local 54321 typ host generation 0",
  "a=candidate:2 1 udp 2122260224 8a1b2c3d-1234-5678-9abc-def012345678.local 54322 typ host generation 0",
].join("\r\n");

const realIpSdp = [
  "v=0",
  "a=ice-ufrag:abcd",
  "a=candidate:1 1 udp 2122260223 192.168.43.10 54321 typ host generation 0",
].join("\r\n");

describe("parseCandidateLine", () => {
  it("parses an SDP line with the a= prefix", () => {
    const parsed = parseCandidateLine(
      "a=candidate:1 1 udp 2122260223 192.168.43.10 54321 typ host generation 0",
    );

    expect(parsed).toMatchObject({
      foundation: "1",
      component: 1,
      transport: "udp",
      address: "192.168.43.10",
      port: 54321,
      type: "host",
    });
  });

  it("parses a raw RTCIceCandidate string", () => {
    const parsed = parseCandidateLine(
      "candidate:2 1 udp 2122260224 8a1b2c3d-1234.local 54322 typ host",
    );

    expect(parsed?.address).toBe("8a1b2c3d-1234.local");
    expect(parsed?.type).toBe("host");
  });

  it("returns null for a non-candidate line", () => {
    expect(parseCandidateLine("a=ice-ufrag:abcd")).toBeNull();
  });
});

describe("isMdnsAddress", () => {
  it("detects mDNS hostnames", () => {
    expect(isMdnsAddress("8a1b2c3d.local")).toBe(true);
    expect(isMdnsAddress("8A1B2C3D.LOCAL.")).toBe(true);
    expect(isMdnsAddress("192.168.43.10")).toBe(false);
  });
});

describe("isValidIPv4", () => {
  it("accepts dotted quads in range", () => {
    expect(isValidIPv4("192.168.43.10")).toBe(true);
    expect(isValidIPv4(" 10.0.0.1 ")).toBe(true);
  });

  it("rejects invalid input", () => {
    expect(isValidIPv4("192.168.43")).toBe(false);
    expect(isValidIPv4("192.168.43.256")).toBe(false);
    expect(isValidIPv4("8a1b2c3d.local")).toBe(false);
    expect(isValidIPv4("")).toBe(false);
  });
});

describe("analyzeSdp", () => {
  it("reports mDNS-only candidates", () => {
    const report = analyzeSdp(mdnsSdp);

    expect(report.total).toBe(2);
    expect(report.host).toBe(2);
    expect(report.mdns).toBe(2);
    expect(report.usable).toBe(0);
    expect(report.verdict).toBe("mdns-only");
  });

  it("reports usable candidates and masks their addresses", () => {
    const report = analyzeSdp(realIpSdp);

    expect(report.usable).toBe(1);
    expect(report.verdict).toBe("usable");
    expect(report.addresses).toEqual(["192.168.x.x"]);
  });

  it("reports no candidates", () => {
    const report = analyzeSdp("v=0\r\n");

    expect(report.total).toBe(0);
    expect(report.verdict).toBe("none");
  });
});

describe("rewriteMdnsCandidates", () => {
  it("replaces mDNS addresses with the given IP and leaves the fingerprint alone", () => {
    const result = rewriteMdnsCandidates(mdnsSdp, "192.168.43.20");

    expect(result.rewritten).toBe(2);
    expect(result.sdp).toContain("192.168.43.20 54321 typ host");
    expect(result.sdp).toContain("192.168.43.20 54322 typ host");
    expect(result.sdp).not.toContain(".local");
    expect(result.sdp).toContain("a=fingerprint:sha-256 AA:BB:CC:DD");
    expect(result.sdp).toContain("a=ice-ufrag:abcd");
  });

  it("is a no-op for an invalid address", () => {
    const result = rewriteMdnsCandidates(mdnsSdp, "not-an-ip");

    expect(result.rewritten).toBe(0);
    expect(result.sdp).toBe(mdnsSdp);
  });

  it("is a no-op when the candidates already have real addresses", () => {
    const result = rewriteMdnsCandidates(realIpSdp, "192.168.43.20");

    expect(result.rewritten).toBe(0);
    expect(result.sdp).toBe(realIpSdp);
  });
});
