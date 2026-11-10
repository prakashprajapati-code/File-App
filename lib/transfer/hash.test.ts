import { describe, expect, it } from "vitest";
import { createContentHasher } from "./hash";

const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("createContentHasher", () => {
  it("hashes data incrementally", async () => {
    const hasher = await createContentHasher();
    hasher.update(new TextEncoder().encode("a"));
    hasher.update(new TextEncoder().encode("bc"));

    expect(hasher.digest()).toBe(SHA256_ABC);
  });

  it("hashes empty input", async () => {
    const hasher = await createContentHasher();

    expect(hasher.digest()).toBe(SHA256_EMPTY);
  });
});
