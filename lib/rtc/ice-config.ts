/**
 * ICE server configuration.
 *
 * Direct host candidates are always preferred (`iceTransportPolicy: "all"`).
 * STUN only adds public `srflx` candidates, which is enough when the LAN
 * advertises mDNS names the other device cannot resolve. TURN is opt-in via
 * `NEXT_PUBLIC_ICE_SERVERS`; when a relay is selected the file bytes travel
 * through it, so leave TURN unset unless direct connectivity is impossible.
 */

export interface IceServerSummary {
  total: number;
  stun: number;
  turn: number;
}

/**
 * Public STUN is contacted during gathering only. Override with
 * `NEXT_PUBLIC_ICE_SERVERS='[]'` to stay fully local.
 */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"],
  },
];

function readUrls(value: unknown): string[] {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return list
    .filter((url): url is string => typeof url === "string")
    .map((url) => url.trim())
    .filter((url) => /^(stuns?|turns?):/i.test(url));
}

function normalizeServer(value: unknown): RTCIceServer[] {
  if (typeof value !== "object" || value === null) return [];
  const raw = value as Record<string, unknown>;
  const urls = readUrls(raw.urls);
  if (urls.length === 0) return [];

  const needsCredential = urls.some((url) => /^turns?:/i.test(url));
  const username = typeof raw.username === "string" ? raw.username : undefined;
  const credential = typeof raw.credential === "string" ? raw.credential : undefined;

  // A TURN URL without credentials can never allocate a relay; drop it instead
  // of letting the browser emit a confusing icecandidateerror later.
  if (needsCredential && (!username || !credential)) return [];

  const server: RTCIceServer = { urls };
  if (username) server.username = username;
  if (credential) server.credential = credential;
  return [server];
}

/**
 * Parses the env value. A missing value uses the default STUN list; an explicit
 * `[]` disables STUN/TURN entirely; invalid JSON falls back to the default.
 */
export function parseIceServers(raw: string | undefined): RTCIceServer[] {
  if (raw === undefined || raw.trim() === "") return DEFAULT_ICE_SERVERS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_ICE_SERVERS;
  }

  if (!Array.isArray(parsed)) return DEFAULT_ICE_SERVERS;
  if (parsed.length === 0) return [];
  return parsed.flatMap(normalizeServer);
}

export function getIceServers(): RTCIceServer[] {
  return parseIceServers(process.env.NEXT_PUBLIC_ICE_SERVERS);
}

export function summarizeIceServers(servers: readonly RTCIceServer[]): IceServerSummary {
  const summary: IceServerSummary = { total: servers.length, stun: 0, turn: 0 };

  for (const server of servers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      if (/^stuns?:/i.test(url)) summary.stun += 1;
      else if (/^turns?:/i.test(url)) summary.turn += 1;
    }
  }

  return summary;
}
