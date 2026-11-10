import { describe, expect, it } from "vitest";
import { isControlMessage } from "./protocol";

describe("isControlMessage", () => {
  it("accepts pairing messages", () => {
    expect(isControlMessage({ t: "HELLO", role: "tv", name: "TV" })).toBe(true);
    expect(isControlMessage({ t: "CONFIRM" })).toBe(true);
    expect(isControlMessage({ t: "REJECT", reason: "mismatch" })).toBe(true);
  });

  it("accepts transfer messages", () => {
    expect(
      isControlMessage({
        t: "META",
        fileId: "abc",
        name: "video.mp4",
        size: 1024,
        mime: "video/mp4",
        lastModified: 1,
      }),
    ).toBe(true);
    expect(isControlMessage({ t: "ACCEPT", fileId: "abc", offset: 0 })).toBe(true);
    expect(isControlMessage({ t: "ACK", offset: 1024 })).toBe(true);
    expect(isControlMessage({ t: "DONE", size: 1024, hash: "abc" })).toBe(true);
    expect(isControlMessage({ t: "COMPLETE", hash: "abc" })).toBe(true);
    expect(isControlMessage({ t: "CANCEL" })).toBe(true);
    expect(isControlMessage({ t: "ERROR", message: "boom" })).toBe(true);
  });

  it("rejects malformed transfer messages", () => {
    expect(isControlMessage({ t: "META", fileId: "", name: "x", size: 1, mime: "", lastModified: 1 })).toBe(false);
    expect(isControlMessage({ t: "META", fileId: "a", name: "x", size: -1, mime: "", lastModified: 1 })).toBe(false);
    expect(isControlMessage({ t: "ACCEPT", fileId: "a", offset: -1 })).toBe(false);
    expect(isControlMessage({ t: "ACK", offset: Number.NaN })).toBe(false);
    expect(isControlMessage({ t: "DONE", size: 1 })).toBe(false);
    expect(isControlMessage({ t: "COMPLETE" })).toBe(false);
  });

  it("rejects unknown messages", () => {
    expect(isControlMessage({ t: "UNKNOWN" })).toBe(false);
    expect(isControlMessage(null)).toBe(false);
    expect(isControlMessage("CONFIRM")).toBe(false);
    expect(isControlMessage({})).toBe(false);
  });
});
