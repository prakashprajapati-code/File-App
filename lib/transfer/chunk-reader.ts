/**
 * Reads a Blob from `offset` and yields exact `chunkSize` pieces. The final
 * piece may be shorter. Only one chunk plus a small carry buffer is in memory.
 */
export async function* readChunks(
  file: Blob,
  offset: number,
  chunkSize: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (offset < 0 || offset > file.size) {
    throw new RangeError("Offset is outside the file.");
  }
  if (chunkSize <= 0) {
    throw new RangeError("Chunk size must be positive.");
  }

  const reader = file.slice(offset).stream().getReader();
  let carry = new Uint8Array(0);

  try {
    while (true) {
      if (signal?.aborted) return;

      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      const combined =
        carry.length === 0
          ? value
          : (() => {
              const next = new Uint8Array(carry.length + value.length);
              next.set(carry);
              next.set(value, carry.length);
              return next;
            })();

      let start = 0;
      while (combined.length - start >= chunkSize) {
        if (signal?.aborted) return;
        yield combined.slice(start, start + chunkSize);
        start += chunkSize;
      }

      carry = combined.slice(start);
    }

    if (carry.length > 0 && !signal?.aborted) {
      yield carry;
    }
  } finally {
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
