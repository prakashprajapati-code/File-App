const FINGERPRINT_PATTERN = /^a=fingerprint:sha-256\s+([0-9a-f:]+)\s*$/im;

/**
 * Extracts the DTLS fingerprint from an SDP. Returns null when the SDP has no
 * sha-256 fingerprint, which means a confirmation code cannot be derived.
 */
export function extractFingerprint(sdp: string): string | null {
  const match = FINGERPRINT_PATTERN.exec(sdp);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Derives the 4-digit confirmation code from both DTLS fingerprints.
 *
 * Both devices must compute the same value from the same pair of SDPs:
 * sort the fingerprints, join them, SHA-256, read the first 4 bytes, mod 10000.
 */
export async function confirmationCode(offerSdp: string, answerSdp: string): Promise<string> {
  const offerFingerprint = extractFingerprint(offerSdp);
  const answerFingerprint = extractFingerprint(answerSdp);

  if (!offerFingerprint || !answerFingerprint) {
    throw new Error("Cannot derive a confirmation code without both DTLS fingerprints.");
  }

  const joined = [offerFingerprint, answerFingerprint].sort().join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(joined));
  const value = new DataView(digest).getUint32(0, false);

  return String(value % 10_000).padStart(4, "0");
}
