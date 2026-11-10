/**
 * Utilities for reading ICE candidates out of an SDP.
 *
 * Browsers hide local addresses behind mDNS names such as
 * `a1b2c3d4-....local` (Chromium `enable-webrtc-hide-local-ips-with-mdns`).
 * On a phone hotspot that multicast resolution often fails, so both sides end
 * up with candidates that can never be reached. `rewriteMdnsCandidates` is the
 * manual fallback: the user types the TV's LAN IP and we substitute it.
 */

export type CandidateType = "host" | "srflx" | "prflx" | "relay" | "unknown";

export type CandidateVerdict = "usable" | "mdns-only" | "none";

export interface ParsedCandidate {
  foundation: string;
  component: number;
  transport: string;
  priority: number;
  address: string;
  port: number;
  type: CandidateType;
  relayProtocol: string | null;
}

export interface CandidateReport {
  total: number;
  host: number;
  srflx: number;
  prflx: number;
  relay: number;
  /** Candidates whose address is an mDNS name instead of an IP. */
  mdns: number;
  ipv4: number;
  ipv6: number;
  /** Candidates with a real, reachable-looking address. */
  usable: number;
  verdict: CandidateVerdict;
  /** Masked (`192.168.x.x`) unique addresses, for the diagnostics panel. */
  addresses: string[];
}

export interface RewriteResult {
  sdp: string;
  rewritten: number;
}

const CANDIDATE_PATTERN =
  /^candidate:(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+typ\s+(\S+)([\s\S]*)$/;

const CANDIDATE_LINE_PATTERN = /^a=candidate:.*$/gim;
const MDNS_TOKEN_PATTERN = /[0-9a-z_.-]+\.local\.?/gi;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const MAX_REPORTED_ADDRESSES = 8;

function toCandidateType(value: string): CandidateType {
  if (value === "host" || value === "srflx" || value === "prflx" || value === "relay") return value;
  return "unknown";
}

/** Parses one SDP candidate line, with or without the `a=` prefix. */
export function parseCandidateLine(line: string): ParsedCandidate | null {
  const normalized = line.trim().replace(/^a=/, "");
  const match = CANDIDATE_PATTERN.exec(normalized);
  if (!match) return null;

  const [, foundation, component, transport, priority, address, port, type, rest] = match;
  const relayProtocol = /tcptype\s+(\S+)/i.exec(rest);

  return {
    foundation,
    component: Number(component),
    transport,
    priority: Number(priority),
    address,
    port: Number(port),
    type: toCandidateType(type),
    relayProtocol: relayProtocol ? relayProtocol[1] : null,
  };
}

export function parseCandidates(sdp: string): ParsedCandidate[] {
  const candidates: ParsedCandidate[] = [];

  for (const line of sdp.split(/\r?\n/)) {
    const candidate = parseCandidateLine(line);
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

export function isMdnsAddress(address: string): boolean {
  return /\.local\.?$/i.test(address.trim());
}

export function isValidIPv4(value: string): boolean {
  const match = IPV4_PATTERN.exec(value.trim());
  if (!match) return false;

  return match.slice(1).every((octet) => {
    const parsed = Number(octet);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255;
  });
}

export function isPrivateIPv4(value: string): boolean {
  if (!isValidIPv4(value)) return false;

  const octets = value.trim().split(".").map(Number);
  const [first, second] = octets;

  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;

  return false;
}

function isUsableAddress(address: string): boolean {
  const trimmed = address.trim();
  if (!trimmed) return false;
  if (isMdnsAddress(trimmed)) return false;
  if (trimmed === "0.0.0.0" || trimmed === "::") return false;
  return true;
}

function maskAddress(address: string): string {
  return address.replace(/(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}/, "$1.x.x");
}

export function analyzeCandidates(candidates: readonly ParsedCandidate[]): CandidateReport {
  let host = 0;
  let srflx = 0;
  let prflx = 0;
  let relay = 0;
  let mdns = 0;
  let ipv4 = 0;
  let ipv6 = 0;
  let usable = 0;

  const addresses = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.type === "host") host += 1;
    else if (candidate.type === "srflx") srflx += 1;
    else if (candidate.type === "prflx") prflx += 1;
    else if (candidate.type === "relay") relay += 1;

    if (isMdnsAddress(candidate.address)) {
      mdns += 1;
      continue;
    }

    if (candidate.address.includes(":")) ipv6 += 1;
    else if (isValidIPv4(candidate.address)) ipv4 += 1;

    if (isUsableAddress(candidate.address)) {
      usable += 1;
      if (addresses.size < MAX_REPORTED_ADDRESSES) addresses.add(maskAddress(candidate.address));
    }
  }

  const verdict: CandidateVerdict =
    candidates.length === 0 ? "none" : usable > 0 ? "usable" : "mdns-only";

  return {
    total: candidates.length,
    host,
    srflx,
    prflx,
    relay,
    mdns,
    ipv4,
    ipv6,
    usable,
    verdict,
    addresses: [...addresses],
  };
}

export function analyzeSdp(sdp: string): CandidateReport {
  return analyzeCandidates(parseCandidates(sdp));
}

/**
 * Replaces every `.local` address in the SDP's candidate lines with a real IP.
 * Everything else (ufrag, pwd, fingerprint, ports) is left untouched so the
 * confirmation code still matches the peer's original offer.
 */
export function rewriteMdnsCandidates(sdp: string, address: string): RewriteResult {
  const trimmed = address.trim();
  if (!isValidIPv4(trimmed)) return { sdp, rewritten: 0 };

  let rewritten = 0;

  const nextSdp = sdp.replace(CANDIDATE_LINE_PATTERN, (line) => {
    if (!/\.local/i.test(line)) return line;
    rewritten += 1;
    return line.replace(MDNS_TOKEN_PATTERN, trimmed);
  });

  return { sdp: nextSdp, rewritten };
}
