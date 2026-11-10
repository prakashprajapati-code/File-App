import { createSHA256 } from "hash-wasm";

export function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface ContentHasher {
  update(chunk: Uint8Array): void;
  digest(): string;
}

/** Incremental SHA-256 so a multi-GB file never needs to be in memory. */
export async function createContentHasher(): Promise<ContentHasher> {
  const hasher = await createSHA256();
  hasher.init();

  return {
    update(chunk) {
      hasher.update(chunk);
    },
    digest() {
      return hasher.digest("hex");
    },
  };
}
