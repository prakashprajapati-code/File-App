import type { ControlMessage } from "@/lib/transfer/protocol";
import { isControlMessage } from "@/lib/transfer/protocol";
import { getIceServers } from "./ice-config";

export const CHANNEL_OPEN_TIMEOUT_MS = 20_000;

export interface PeerChannels {
  control: RTCDataChannel;
  data: RTCDataChannel;
}

/**
 * Direct host candidates stay preferred. STUN is used only to obtain a
 * reachable address when the network hides local addresses behind mDNS.
 */
export function createPeerConnection(iceServers: RTCIceServer[] = getIceServers()): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers });
}

/**
 * SDP is sent immediately; candidates that arrive later go through the
 * candidate mailbox. Waiting for gathering here dropped every late candidate.
 */
export async function createOffer(pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return pc.localDescription ?? offer;
}

export async function createAnswer(
  pc: RTCPeerConnection,
  offer: RTCSessionDescriptionInit,
): Promise<RTCSessionDescriptionInit> {
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
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
