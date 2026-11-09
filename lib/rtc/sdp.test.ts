import { describe, expect, it } from "vitest";
import { confirmationCode, extractFingerprint } from "./sdp";

const offerSdp = [
  "v=0",
  "o=- 1 1 IN IP4 127.0.0.1",
  "a=fingerprint:sha-256 AA:BB:CC:DD",
].join("\r\n");

const answerSdp = [
  "v=0",
  "o=- 2 2 IN IP4 127.0.0.1",
  "a=fingerprint:sha-256 11:22:33:44",
].join("\r\n");

describe("extractFingerprint", () => {
  it("extracts and normalizes the sha-256 fingerprint", () => {
    expect(extractFingerprint(offerSdp)).toBe("AA:BB:CC:DD");
  });

  it("returns null when there is no fingerprint", () => {
    expect(extractFingerprint("v=0\r\n")).toBeNull();
  });
});

describe("confirmationCode", () => {
  it("returns four digits", async () => {
    await expect(confirmationCode(offerSdp, answerSdp)).resolves.toMatch(/^\d{4}$/);
  });

  it("is deterministic", async () => {
    const first = await confirmationCode(offerSdp, answerSdp);
    const second = await confirmationCode(offerSdp, answerSdp);
    expect(first).toBe(second);
  });

  it("is order independent", async () => {
    const forward = await confirmationCode(offerSdp, answerSdp);
    const reverse = await confirmationCode(answerSdp, offerSdp);
    expect(forward).toBe(reverse);
  });

  it("throws when a fingerprint is missing", async () => {
    await expect(confirmationCode(offerSdp, "v=0")).rejects.toThrow();
  });
});
