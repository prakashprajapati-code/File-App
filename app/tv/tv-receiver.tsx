"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmCode } from "@/components/ConfirmCode";
import { QrCode } from "@/components/QrCode";
import { StatusScreen } from "@/components/StatusScreen";
import { TvButton } from "@/components/TvButton";
import { createRoom, deleteRoom, getAnswer } from "@/lib/client/api";
import { createLogger } from "@/lib/log/logger";
import { explainConnectionFailure, snapshotPeer, trackPeerConnection } from "@/lib/log/webrtc";
import { analyzeSdp } from "@/lib/rtc/candidates";
import type { CandidateReport } from "@/lib/rtc/candidates";
import { getDeviceName } from "@/lib/rtc/device";
import {
  createChannels,
  createOffer,
  createPeerConnection,
  parseControl,
  sendControl,
  waitForChannelOpen,
} from "@/lib/rtc/peer";
import type { PeerChannels } from "@/lib/rtc/peer";
import { confirmationCode } from "@/lib/rtc/sdp";
import type { ControlMessage } from "@/lib/transfer/protocol";

const POLL_INTERVAL_MS = 1_000;
const ROOM_TTL_MS = 120_000;

type TvState =
  | { phase: "creating" }
  | { phase: "waiting"; code: string; qrUrl: string }
  | { phase: "confirming"; confirmation: string }
  | { phase: "connected"; deviceName: string }
  | { phase: "error"; title: string; message: string };

export function TvReceiver() {
  const [state, setState] = useState<TvState>({ phase: "creating" });
  const [attempt, setAttempt] = useState(0);
  const phoneNameRef = useRef("Phone");
  const log = useMemo(() => createLogger("tv", "tv"), []);

  useEffect(() => {
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let channels: PeerChannels | null = null;
    let stopPeerTracking: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let roomCode: string | null = null;
    let roomToken: string | null = null;
    let finished = false;
    let offerReport: CandidateReport | null = null;
    let answerReport: CandidateReport | null = null;

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
      // void deleteRoom(code, token).catch(() => undefined);
    };

    const fail = (message: string, title = "Something went wrong") => {
      if (cancelled || finished) return;
      finished = true;
      log.error("state:error", { title, message });

      stopPolling();
      releaseRoom();

      const doomed = pc;
      const doomedChannels = channels ? [channels.control, channels.data] : [];
      pc = null;

      setState({ phase: "error", title, message });

      // Capture the stats before closing, otherwise the snapshot is useless.
      if (doomed) {
        void snapshotPeer(doomed, doomedChannels)
          .then((snapshot) => log.error("peer:snapshot", { peer: snapshot }))
          .catch(() => undefined)
          .finally(() => doomed.close());
      }
    };

    const succeed = (deviceName: string) => {
      if (cancelled || finished) return;
      log.mark("state:connected", { deviceName });
      stopPolling();
      releaseRoom();
      setState({ phase: "connected", deviceName });
    };

    const handleControlMessage = (message: ControlMessage) => {
      if (cancelled) return;
      log.info("control:message", { type: message.t, role: "role" in message ? message.role : null });

      if (message.t === "HELLO") {
        phoneNameRef.current = message.name;
        return;
      }
      if (message.t === "CONFIRM") {
        succeed(phoneNameRef.current);
        return;
      }
      if (message.t === "REJECT") {
        fail("The codes did not match, so the connection was closed.", "Codes did not match");
      }
    };

    const start = async () => {
      setState({ phase: "creating" });
      phoneNameRef.current = "Phone";
      log.mark("attempt:start", { attempt: attempt + 1 });

      try {
        const connection = createPeerConnection();
        pc = connection;
        stopPeerTracking = trackPeerConnection(connection, log.child("rtc"));

        const peerChannels = createChannels(connection);
        channels = peerChannels;
        log.info("channels:created", { labels: [peerChannels.control.label, peerChannels.data.label] });

        connection.addEventListener("connectionstatechange", () => {
          if (cancelled) return;
          if (connection.connectionState !== "failed") return;

          const explanation = explainConnectionFailure({
            snapshot: null,
            local: offerReport,
            remote: answerReport,
          });
          fail(explanation.message, explanation.title);
        });

        // Attach before the channel opens so the first HELLO is never missed.
        peerChannels.control.addEventListener("message", (event) => {
          const message = parseControl(String(event.data));
          if (message) handleControlMessage(message);
        });
        peerChannels.control.addEventListener("close", () => fail("The phone disconnected."));

        const offer = await createOffer(connection);
        if (cancelled) return;

        offerReport = analyzeSdp(offer.sdp ?? "");
        log.info("offer:created", { candidates: offerReport });
        if (offerReport.verdict === "none") {
          const explanation = explainConnectionFailure({ snapshot: null, local: offerReport, remote: null });
          fail(explanation.message, explanation.title);
          return;
        }

        const room = await createRoom(offer);
        roomCode = room.code;
        roomToken = room.token;
        log.info("room:created", { code: room.code });

        if (cancelled) {
          releaseRoom();
          return;
        }

        setState({
          phase: "waiting",
          code: room.code,
          qrUrl: `${window.location.origin}/send?code=${room.code}`,
        });
        log.mark("state:waiting", { code: room.code });

        const startedAt = Date.now();
        const deadline = startedAt + ROOM_TTL_MS;
        let pollCount = 0;

        const poll = async () => {
          if (cancelled || !pc) return;
          if (Date.now() >= deadline) {
            fail("This code expired. Show a new code.");
            return;
          }

          pollCount += 1;

          try {
            const answer = await getAnswer(room.code, room.token);
            if (cancelled || !pc) return;

            if (!answer) {
              pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
              return;
            }

            log.info("poll:answer-received", { polls: pollCount, elapsedMs: Date.now() - startedAt });

            await connection.setRemoteDescription(answer);
            answerReport = analyzeSdp(answer.sdp ?? "");
            log.info("pc:remote-description-set", { candidates: answerReport });

            if (answerReport.verdict === "none") {
              const explanation = explainConnectionFailure({
                snapshot: null,
                local: offerReport,
                remote: answerReport,
              });
              fail(explanation.message, explanation.title);
              return;
            }

            const confirmation = await confirmationCode(offer.sdp ?? "", answer.sdp ?? "");
            if (cancelled) return;
            log.info("confirm:code", { confirmation });

            // The room has done its job once the answer is in.
            releaseRoom();
            setState({ phase: "confirming", confirmation });
            log.mark("state:confirming");

            await Promise.all([
              waitForChannelOpen(peerChannels.control),
              waitForChannelOpen(peerChannels.data),
            ]);
            if (cancelled) return;
            log.info("channels:open");

            sendControl(peerChannels.control, {
              t: "HELLO",
              role: "tv",
              name: getDeviceName(),
            });
            log.info("control:hello-sent", { name: getDeviceName() });
          } catch (error) {
            const explanation = failureFromError(error, offerReport, answerReport);
            fail(explanation.message, explanation.title);
          }
        };

        void poll();
      } catch (error) {
        const explanation = failureFromError(error, offerReport, answerReport);
        fail(explanation.message, explanation.title);
      }
    };

    void start();

    return () => {
      cancelled = true;
      log.info("attempt:cleanup");
      stopPolling();
      releaseRoom();
      stopPeerTracking?.();
      pc?.close();
      pc = null;
    };
  }, [attempt, log]);

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
    <StatusScreen title={state.title} message={state.message}>
      <TvButton onClick={() => setAttempt((value) => value + 1)}>Try again</TvButton>
    </StatusScreen>
  );
}

/**
 * Prefers the specific WebRTC explanation over a raw channel timeout message,
 * so the screen names the real cause instead of "did not open in time".
 */
function failureFromError(
  error: unknown,
  local: CandidateReport | null,
  remote: CandidateReport | null,
): { title: string; message: string } {
  const raw = error instanceof Error ? error.message : "Could not receive the answer.";

  if (/did not open in time|closed before opening/i.test(raw)) {
    return explainConnectionFailure({ snapshot: null, local, remote });
  }

  return { title: "Something went wrong", message: raw };
}
