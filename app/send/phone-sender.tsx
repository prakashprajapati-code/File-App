"use client";

import { useEffect, useRef, useState } from "react";
import { ConfirmCode } from "@/components/ConfirmCode";
import { StatusScreen } from "@/components/StatusScreen";
import { TvButton } from "@/components/TvButton";
import { ApiError, claimRoom, postAnswer } from "@/lib/client/api";
import { getDeviceName } from "@/lib/rtc/device";
import {
  createAnswer,
  createPeerConnection,
  parseControl,
  sendControl,
  waitForChannelOpen,
} from "@/lib/rtc/peer";
import { confirmationCode } from "@/lib/rtc/sdp";
import type { ControlMessage } from "@/lib/transfer/protocol";

type PhoneState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "confirming"; confirmation: string; channelReady: boolean }
  | { phase: "connected"; deviceName: string }
  | { phase: "error"; message: string };

interface PhoneSenderProps {
  initialCode: string;
}

export function PhoneSender({ initialCode }: PhoneSenderProps) {
  const [codeInput, setCodeInput] = useState(initialCode);
  const [state, setState] = useState<PhoneState>({ phase: "idle" });
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const controlRef = useRef<RTCDataChannel | null>(null);
  const tvNameRef = useRef("TV");
  const mountedRef = useRef(true);
  const connectingRef = useRef(false);
  const lastErrorRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pcRef.current?.close();
      pcRef.current = null;
    };
  }, []);

  const update = (next: PhoneState) => {
    if (mountedRef.current) setState(next);
  };

  const reset = () => {
    pcRef.current?.close();
    pcRef.current = null;
    controlRef.current = null;
    tvNameRef.current = "TV";
  };

  const handleControlMessage = (message: ControlMessage) => {
    if (message.t === "HELLO") {
      tvNameRef.current = message.name;
    }
  };

  const connect = async (rawCode: string) => {
    const code = rawCode.trim();
    if (!/^\d{4}$/.test(code)) {
      update({ phase: "error", message: "Enter the 4-digit code shown on the TV." });
      return;
    }

    if (connectingRef.current) return;
    connectingRef.current = true;
    lastErrorRef.current = null;

    reset();
    update({ phase: "connecting" });

    try {
      const { offer, claimToken } = await claimRoom(code);
      if (!mountedRef.current) return;

      const pc = createPeerConnection();
      pcRef.current = pc;

      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState !== "failed") return;
        lastErrorRef.current =
          "Could not connect. Check that both devices are on the same Wi-Fi or hotspot.";
        update({ phase: "error", message: lastErrorRef.current });
        reset();
      });

      let control: RTCDataChannel | null = null;
      let data: RTCDataChannel | null = null;

      const channelsReady = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("The TV did not open the data channels in time.")),
          20_000,
        );

        pc.ondatachannel = (event) => {
          const channel = event.channel;
          if (channel.label === "control") {
            control = channel;
            controlRef.current = channel;
            channel.addEventListener("message", (messageEvent) => {
              const message = parseControl(String(messageEvent.data));
              if (message) handleControlMessage(message);
            });
          }
          if (channel.label === "data") {
            channel.binaryType = "arraybuffer";
            data = channel;
          }
          if (control && data) {
            clearTimeout(timer);
            resolve();
          }
        };
      });

      const answer = await createAnswer(pc, offer);
      await postAnswer(code, answer, claimToken);

      const confirmation = await confirmationCode(offer.sdp ?? "", answer.sdp ?? "");
      update({ phase: "confirming", confirmation, channelReady: false });

      await channelsReady;
      if (!control || !data) throw new Error("The TV did not open the data channels.");

      await Promise.all([waitForChannelOpen(control), waitForChannelOpen(data)]);
      if (!mountedRef.current) return;

      sendControl(control, { t: "HELLO", role: "phone", name: getDeviceName() });

      setState((current) =>
        current.phase === "confirming" ? { ...current, channelReady: true } : current,
      );
    } catch (error) {
      reset();
      update({
        phase: "error",
        message:
          lastErrorRef.current ??
          (error instanceof ApiError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Could not connect."),
      });
    } finally {
      connectingRef.current = false;
    }
  };

  const confirm = () => {
    const control = controlRef.current;
    if (!control) return;
    sendControl(control, { t: "CONFIRM" });
    update({ phase: "connected", deviceName: tvNameRef.current });
  };

  const reject = () => {
    reset();
    update({ phase: "error", message: "Codes did not match. Connection closed." });
  };

  if (state.phase === "idle") {
    return (
      <StatusScreen title="Connect to the TV" message="Enter the 4-digit code shown on the TV.">
        <form
          className="flex flex-col items-center gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void connect(codeInput);
          }}
        >
          <label htmlFor="tv-code" className="sr-only">
            4-digit TV code
          </label>
          <input
            id="tv-code"
            value={codeInput}
            onChange={(event) => setCodeInput(event.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={4}
            className="w-64 rounded-2xl border-2 border-zinc-700 bg-zinc-900 px-4 py-4 text-center font-mono text-5xl tracking-[0.3em] text-white focus:border-emerald-400 focus:outline-none"
          />
          <TvButton type="submit" disabled={codeInput.length !== 4}>
            Connect
          </TvButton>
        </form>
      </StatusScreen>
    );
  }

  if (state.phase === "connecting") {
    return (
      <StatusScreen
        title="Connecting"
        message="Claiming the code and opening the data channel..."
      />
    );
  }

  if (state.phase === "confirming") {
    return (
      <StatusScreen title="Check the code">
        <ConfirmCode
          code={state.confirmation}
          onMatch={confirm}
          onMismatch={reject}
          disabled={!state.channelReady}
        />
        <p className="text-sm text-zinc-500" role="status">
          {state.channelReady ? "Ready." : "Waiting for the data channel..."}
        </p>
      </StatusScreen>
    );
  }

  if (state.phase === "connected") {
    return (
      <StatusScreen title="Connected" message={`Connected to ${state.deviceName}`}>
        <p className="text-lg text-zinc-400">The file picker arrives in Phase 3.</p>
      </StatusScreen>
    );
  }

  return (
    <StatusScreen title="Could not connect" message={state.message}>
      <TvButton onClick={() => setState({ phase: "idle" })}>Try again</TvButton>
    </StatusScreen>
  );
}
