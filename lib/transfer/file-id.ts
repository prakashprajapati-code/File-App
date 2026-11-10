import { toHex } from "./hash";

interface FileIdentity {
  name: string;
  size: number;
  lastModified: number;
}

/**
 * Identifies a file across reconnects. This is a metadata hash, not a content
 * hash; the content SHA-256 is computed while streaming.
 */
export async function fileIdFor(file: FileIdentity): Promise<string> {
  const input = new TextEncoder().encode(
    `${file.name}|${file.size}|${file.lastModified}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", input);
  return toHex(digest);
}
