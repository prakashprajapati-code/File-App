import { describe, expect, it } from "vitest";
import { fileIdFor } from "./file-id";

describe("fileIdFor", () => {
  it("is deterministic and hex encoded", async () => {
    const file = { name: "video.mp4", size: 1024, lastModified: 1_700_000_000_000 };

    const first = await fileIdFor(file);
    const second = await fileIdFor(file);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the metadata changes", async () => {
    const first = await fileIdFor({ name: "a.bin", size: 1, lastModified: 1 });
    const second = await fileIdFor({ name: "a.bin", size: 2, lastModified: 1 });

    expect(first).not.toBe(second);
  });
});
