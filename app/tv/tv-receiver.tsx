"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmCode } from "@/components/ConfirmCode";
import { QrCode } from "@/components/QrCode";
import { StatusScreen } from "@/components/StatusScreen";
import { TvButton } from "@/components/TvButton";
import {
  createRoom,
  deleteRoom,
  getAnswer,
  getCandidates,
  postCandidates,
} from "@/lib/client/api";
import { createLogger } from "@/lib/log/logger";
import { capturePeerDiagnostics } from "@/lib/log/diagnose";
import type { DiagnosticError, DiagnosticPhase } from "@/lib/log/diagnose";
import { ROOM_TTL_SECONDS } from "@/lib/rooms/config";
import { getIceServers, summarizeIceServers } from "@/lib/rtc/ice-config";
import { createIceTrickle } from "@/lib/rtc/trickle";
import type { IceTrickle } from "@/lib/rtc/trickle";
import {
  emptyCandidateCounts,
  explainConnectionFailure,
  trackDataChannel,
  trackPeerConnection,
} from "@/lib/log/webrtc";
import type { PeerTracker } from "@/lib/log/webrtc";
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
const ROOM_TTL_MS = ROOM_TTL_SECONDS * 1_000;

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
    let tracker: PeerTracker | null = null;
    let trickle: IceTrickle | null = null;
    let stopChannelTracking: Array<() => void> = [];
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let roomCode: string | null = null;
    let roomToken: string | null = null;
    let finished = false;
    let offerReport: CandidateReport | null = null;
    let answerReport: CandidateReport | null = null;
    let phase: DiagnosticPhase = "answer-wait";
    let firstError: DiagnosticError | null = null;
    let signalingLost = false;
    let configuredTurn = 0;
    let startedAt = Date.now();

    const recordError = (event: string, detail: string) => {
      if (!firstError) firstError = { event, detail };
    };

    const stopPolling = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const releaseRoom = (remove = false) => {
      if (!roomCode || !roomToken) return;
      const code = roomCode;
      const token = roomToken;
      roomCode = null;
      roomToken = null;
      log.info("room:release", {
        code,
        phase,
        localCandidates: tracker?.counts().total ?? 0,
        deleted: remove,
      });

      if (remove) {
        void deleteRoom(code, token)
          .then(() => log.info("room:deleted", { code }))
          .catch((error: unknown) => {
            log.warn("room:delete-failed", {
              code,
              error: error instanceof Error ? error.name : "unknown",
            });
          });
      }
    };

    const fail = (message: string, title = "Something went wrong", event = "fail") => {
      if (cancelled || finished) return;
      finished = true;
      recordError(event, `${title}: ${message}`);
      log.error("state:error", { title, message, phase });

      stopPolling();
      trickle?.stop();

      const doomed = pc;
      const doomedChannels = channels ? [channels.control, channels.data] : [];
      const local = tracker?.counts() ?? emptyCandidateCounts();
      const ice = trickle?.counts() ?? null;
      const elapsedMs = Date.now() - startedAt;

      // Stop using the connection immediately, but keep it alive until the
      // diagnostic snapshot has been read. A closed peer reports nothing.
      pc = null;

      setState({ phase: "error", title, message });

      if (doomed) {
        void capturePeerDiagnostics({
          role: "tv",
          phase,
          pc: doomed,
          channels: doomedChannels,
          local,
          trickle: ice,
          configuredTurn,
          signalingLost: signalingLost || ice?.signalingLost === true,
          firstError,
          elapsedMs,
        })
          .then(({ snapshot, report }) => {
            log.error("peer:snapshot", { peer: snapshot });
            log.error("diagnostics:report", report);
            if (report.case !== "OK") {
              log.warn("diagnostics:case", { case: report.case, title: report.title });
            }
          })
          .catch((error: unknown) => {
            log.warn("diagnostics:failed", {
              error: error instanceof Error ? error.name : "unknown",
            });
          })
          .finally(() => {
            doomed.close();
            releaseRoom();
          });
      } else {
        releaseRoom();
      }
    };

    const succeed = (deviceName: string) => {
      if (cancelled || finished) return;
      finished = true;
      phase = "connected";
      log.mark("state:connected", { deviceName });
      stopPolling();
      trickle?.stop();
      // CONFIRM is the point where the room is no longer needed. Deleting it
      // earlier would cut off candidate exchange for the other side.
      releaseRoom(true);
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
      phase = "answer-wait";
      firstError = null;
      signalingLost = false;
      startedAt = Date.now();
      offerReport = null;
      answerReport = null;
      log.mark("attempt:start", { attempt: attempt + 1 });
      const iceServers = summarizeIceServers(getIceServers());
      configuredTurn = iceServers.turn;
      log.info("session:env", {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        secureContext: window.isSecureContext,
        hasPeerConnection: typeof RTCPeerConnection === "function",
        origin: window.location.origin,
        iceServers,
      });

      try {
        const connection = createPeerConnection();
        pc = connection;
        tracker = trackPeerConnection(connection, log.child("rtc"));

        const peerChannels = createChannels(connection);
        channels = peerChannels;
        stopChannelTracking = [
          trackDataChannel(peerChannels.control, log.child("rtc")),
          trackDataChannel(peerChannels.data, log.child("rtc")),
        ];
        log.info("channels:created", { labels: [peerChannels.control.label, peerChannels.data.label] });

        // Capture before the offer exists so early host candidates are buffered
        // until the room (and therefore the mailbox) has been created.
        trickle = createIceTrickle({
          pc: connection,
          log: log.child("ice"),
          transport: {
            post: (candidates, complete) => {
              if (!roomCode || !roomToken) {
                return Promise.reject(new Error("Room is not ready."));
              }
              return postCandidates(roomCode, { token: roomToken }, candidates, complete);
            },
            get: (since) => {
              if (!roomCode || !roomToken) {
                return Promise.reject(new Error("Room is not ready."));
              }
              return getCandidates(roomCode, { token: roomToken }, since);
            },
          },
        });
        trickle.capture();

        connection.addEventListener("iceconnectionstatechange", () => {
          log.info("ice:state", { state: connection.iceConnectionState, phase });
          if (
            connection.iceConnectionState === "checking" &&
            (phase === "answer-wait" || phase === "remote-description")
          ) {
            phase = "checking";
          }
        });

        connection.addEventListener("connectionstatechange", () => {
          if (cancelled) return;
          if (connection.connectionState !== "failed") return;

          const explanation = explainConnectionFailure({
            snapshot: null,
            local: offerReport,
            remote: answerReport,
          });
          fail(explanation.message, explanation.title, "connectionstatechange:failed");
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

        const room = await createRoom(offer);
        roomCode = room.code;
        roomToken = room.token;
        log.info("room:created", { code: room.code });

        if (cancelled) {
          releaseRoom();
          return;
        }

        // Candidates captured before this point were buffered; this flushes
        // them and starts the remote mailbox poll. Candidates that arrive
        // before setRemoteDescription are queued by the controller.
        trickle.start();
        trickle.pollRemote();

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
            signalingLost = true;
            fail("This code expired. Show a new code.", "Code expired", "room:expired");
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

            phase = "remote-description";
            await connection.setRemoteDescription(answer);
            answerReport = analyzeSdp(answer.sdp ?? "");
            log.info("pc:remote-description-set", { candidates: answerReport });

            // Queued candidates can only be applied once the answer is set.
            await trickle?.applyRemote();
            log.info("trickle:counts", { counts: trickle?.counts() ?? null });

            const confirmation = await confirmationCode(offer.sdp ?? "", answer.sdp ?? "");
            if (cancelled) return;
            log.info("confirm:code", { confirmation });

            phase = "channel-wait";
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
            fail(explanation.message, explanation.title, "poll:error");
          }
        };

        void poll();
      } catch (error) {
        const explanation = failureFromError(error, offerReport, answerReport);
        fail(explanation.message, explanation.title, "start:error");
      }
    };

    void start();

    return () => {
      cancelled = true;
      phase = "closed";
      log.info("attempt:cleanup", {
        localCandidates: tracker?.counts().total ?? 0,
        channels: channels
          ? [channels.control.readyState, channels.data.readyState]
          : [],
      });
      stopPolling();
      releaseRoom();
      trickle?.stop();
      trickle = null;
      tracker?.stop();
      tracker = null;
      for (const stop of stopChannelTracking) stop();
      stopChannelTracking = [];
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
