import type { ControlMessage } from "@/lib/transfer/protocol";
import { isControlMessage } from "@/lib/transfer/protocol";

export const ICE_GATHERING_TIMEOUT_MS = 5_000;
export const CHANNEL_OPEN_TIMEOUT_MS = 20_000;

export interface PeerChannels {
  control: RTCDataChannel;
  data: RTCDataChannel;
}

/** No STUN and no TURN: candidates must be local (same Wi-Fi / hotspot). */
export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: [] });
}

export function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs = ICE_GATHERING_TIMEOUT_MS,
): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener("icegatheringstatechange", handleStateChange);
      clearTimeout(timer);
      resolve();
    };

    const handleStateChange = () => {
      if (pc.iceGatheringState === "complete") finish();
    };

    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", handleStateChange);
    if (pc.iceGatheringState === "complete") finish();
  });
}

export async function createOffer(pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc);
  return pc.localDescription ?? offer;
}

export async function createAnswer(
  pc: RTCPeerConnection,
  offer: RTCSessionDescriptionInit,
): Promise<RTCSessionDescriptionInit> {
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGathering(pc);
  return pc.localDescription ?? answer;
}

/** TV creates both channels before the offer, so they are negotiated in the SDP. */
export function createChannels(pc: RTCPeerConnection): PeerChannels {
  const control = pc.createDataChannel("control", { ordered: true });
  const data = pc.createDataChannel("data", { ordered: true });
  data.binaryType = "arraybuffer";
  return { control, data };
}

export function waitForChannelOpen(
  channel: RTCDataChannel,
  timeoutMs = CHANNEL_OPEN_TIMEOUT_MS,
): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener("open", handleOpen);
      channel.removeEventListener("close", handleClose);
      channel.removeEventListener("error", handleClose);
    };

    const handleOpen = () => {
      cleanup();
      resolve();
    };

    const handleClose = () => {
      cleanup();
      reject(new Error(`Data channel "${channel.label}" closed before opening.`));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Data channel "${channel.label}" did not open in time.`));
    }, timeoutMs);

    channel.addEventListener("open", handleOpen);
    channel.addEventListener("close", handleClose);
    channel.addEventListener("error", handleClose);
  });
}

export function sendControl(channel: RTCDataChannel, message: ControlMessage): void {
  if (channel.readyState !== "open") return;
  channel.send(JSON.stringify(message));
}

export function parseControl(data: string): ControlMessage | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return isControlMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
