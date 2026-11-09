"use client";

import { useEffect, useRef, useState } from "react";
import { ConfirmCode } from "@/components/ConfirmCode";
import { QrCode } from "@/components/QrCode";
import { StatusScreen } from "@/components/StatusScreen";
import { TvButton } from "@/components/TvButton";
import { createRoom, deleteRoom, getAnswer } from "@/lib/client/api";
import { getDeviceName } from "@/lib/rtc/device";
import {
  createChannels,
  createOffer,
  createPeerConnection,
  parseControl,
  sendControl,
  waitForChannelOpen,
} from "@/lib/rtc/peer";
import { confirmationCode } from "@/lib/rtc/sdp";
import type { ControlMessage } from "@/lib/transfer/protocol";

const POLL_INTERVAL_MS = 1_000;
const ROOM_TTL_MS = 120_000;

type TvState =
  | { phase: "creating" }
  | { phase: "waiting"; code: string; qrUrl: string }
  | { phase: "confirming"; confirmation: string }
  | { phase: "connected"; deviceName: string }
  | { phase: "error"; message: string };

export function TvReceiver() {
  const [state, setState] = useState<TvState>({ phase: "creating" });
  const [attempt, setAttempt] = useState(0);
  const phoneNameRef = useRef("Phone");

  useEffect(() => {
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let roomCode: string | null = null;
    let roomToken: string | null = null;

    const stopPolling = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const releaseRoom = () => {
      if (!roomCode || !roomToken) return;
      const code = roomCode;
      const token = roomToken;
      roomCode = null;
      roomToken = null;
      void deleteRoom(code, token).catch(() => undefined);
    };

    const fail = (message: string) => {
      if (cancelled) return;
      stopPolling();
      releaseRoom();
      pc?.close();
      pc = null;
      setState({ phase: "error", message });
    };

    const handleControlMessage = (message: ControlMessage) => {
      if (cancelled) return;
      if (message.t === "HELLO") {
        phoneNameRef.current = message.name;
      }
      if (message.t === "CONFIRM") {
        setState({ phase: "connected", deviceName: phoneNameRef.current });
      }
    };

    const start = async () => {
      setState({ phase: "creating" });
      phoneNameRef.current = "Phone";

      try {
        pc = createPeerConnection();
        const channels = createChannels(pc);

        pc.addEventListener("connectionstatechange", () => {
          if (pc?.connectionState === "failed") {
            fail("Could not connect. Check that both devices are on the same Wi-Fi or hotspot.");
          }
        });

        // Attach before the channel opens so the first HELLO is never missed.
        channels.control.addEventListener("message", (event) => {
          const message = parseControl(String(event.data));
          if (message) handleControlMessage(message);
        });
        channels.control.addEventListener("close", () => fail("The phone disconnected."));

        const offer = await createOffer(pc);
        if (cancelled) return;

        const room = await createRoom(offer);
        roomCode = room.code;
        roomToken = room.token;

        if (cancelled) {
          releaseRoom();
          return;
        }

        setState({
          phase: "waiting",
          code: room.code,
          qrUrl: `${window.location.origin}/send?code=${room.code}`,
        });

        const deadline = Date.now() + ROOM_TTL_MS;

        const poll = async () => {
          if (cancelled || !pc) return;
          if (Date.now() >= deadline) {
            fail("This code expired. Show a new code.");
            return;
          }

          try {
            const answer = await getAnswer(room.code, room.token);
            if (cancelled || !pc) return;

            if (!answer) {
              pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
              return;
            }

            await pc.setRemoteDescription(answer);
            const confirmation = await confirmationCode(offer.sdp ?? "", answer.sdp ?? "");
            if (cancelled) return;

            // The room has done its job once the answer is in.
            releaseRoom();
            setState({ phase: "confirming", confirmation });

            await Promise.all([
              waitForChannelOpen(channels.control),
              waitForChannelOpen(channels.data),
            ]);
            if (cancelled) return;

            sendControl(channels.control, {
              t: "HELLO",
              role: "tv",
              name: getDeviceName(),
            });
          } catch (error) {
            fail(error instanceof Error ? error.message : "Could not receive the answer.");
          }
        };

        void poll();
      } catch (error) {
        fail(error instanceof Error ? error.message : "Could not create a pairing code.");
      }
    };

    void start();

    return () => {
      cancelled = true;
      stopPolling();
      releaseRoom();
      pc?.close();
      pc = null;
    };
  }, [attempt]);

  if (state.phase === "creating") {
    return <StatusScreen title="Setting up the TV" message="Creating a pairing code..." />;
  }

  if (state.phase === "waiting") {
    return (
      <StatusScreen
        title="Scan to send a file"
        message="Open the camera on your phone and scan this code, or type the 4-digit code on the phone."
      >
        <QrCode value={state.qrUrl} />
        <p
          className="font-mono text-7xl font-bold tracking-[0.25em] text-white sm:text-8xl"
          aria-label={`Room code ${state.code.split("").join(" ")}`}
        >
          {state.code}
        </p>
        <p className="text-lg text-zinc-400" role="status">
          Waiting for your phone...
        </p>
      </StatusScreen>
    );
  }

  if (state.phase === "confirming") {
    return (
      <StatusScreen title="Check the code">
        <ConfirmCode code={state.confirmation} />
        <p className="text-lg text-zinc-400" role="status">
          Tap &ldquo;Matches&rdquo; on your phone to continue.
        </p>
      </StatusScreen>
    );
  }

  if (state.phase === "connected") {
    return (
      <StatusScreen title="Connected" message={`Connected: ${state.deviceName}`}>
        <p className="text-lg text-zinc-400">Ready to receive a file.</p>
      </StatusScreen>
    );
  }

  return (
    <StatusScreen title="Something went wrong" message={state.message}>
      <TvButton onClick={() => setAttempt((value) => value + 1)}>Try again</TvButton>
    </StatusScreen>
  );
}
