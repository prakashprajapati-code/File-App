import { describe, expect, it } from "vitest";
import { readChunks } from "./chunk-reader";

async function collect(generator: AsyncGenerator<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of generator) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("readChunks", () => {
  it("splits a file into exact chunks plus a tail", async () => {
    const file = new Blob([new Uint8Array(35 * 1024)]);
    const chunks = await collect(readChunks(file, 0, 16 * 1024));

    expect(chunks.map((chunk) => chunk.length)).toEqual([16_384, 16_384, 3_072]);
  });

  it("starts at the requested offset", async () => {
    const file = new Blob([new Uint8Array(40 * 1024)]);
    const chunks = await collect(readChunks(file, 10 * 1024, 16 * 1024));

    expect(chunks.reduce((total, chunk) => total + chunk.length, 0)).toBe(30 * 1024);
  });

  it("stops when aborted", async () => {
    const file = new Blob([new Uint8Array(64 * 1024)]);
    const controller = new AbortController();
    const chunks: Uint8Array[] = [];

    for await (const chunk of readChunks(file, 0, 16 * 1024, controller.signal)) {
      chunks.push(chunk);
      controller.abort();
    }

    expect(chunks).toHaveLength(1);
  });

  it("rejects an offset outside the file", async () => {
    const file = new Blob([new Uint8Array(10)]);
    const iterate = async () => collect(readChunks(file, 11, 4));

    await expect(iterate()).rejects.toThrow(RangeError);
  });
});
