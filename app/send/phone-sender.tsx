"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ConfirmCode } from "@/components/ConfirmCode";
import { StatusScreen } from "@/components/StatusScreen";
import { TvButton } from "@/components/TvButton";
import {
  ApiError,
  claimRoom,
  getCandidates,
  postAnswer,
  postCandidates,
} from "@/lib/client/api";
import {
  clearClaimToken,
  createClaimToken,
  readClaimToken,
  writeClaimToken,
} from "@/lib/client/claim-token";
import { withRetry } from "@/lib/client/retry";
import { createLogger } from "@/lib/log/logger";
import { capturePeerDiagnostics } from "@/lib/log/diagnose";
import type { DiagnosticError, DiagnosticPhase } from "@/lib/log/diagnose";
import {
  explainConnectionFailure,
  trackDataChannel,
  trackPeerConnection,
} from "@/lib/log/webrtc";
import type { PeerTracker } from "@/lib/log/webrtc";
import { analyzeSdp, isValidIPv4, rewriteMdnsCandidates } from "@/lib/rtc/candidates";
import type { CandidateReport } from "@/lib/rtc/candidates";
import { getDeviceName } from "@/lib/rtc/device";
import { getIceServers, summarizeIceServers } from "@/lib/rtc/ice-config";
import {
  createAnswer,
  createPeerConnection,
  parseControl,
  sendControl,
  waitForChannelOpen,
} from "@/lib/rtc/peer";
import { confirmationCode } from "@/lib/rtc/sdp";
import { createIceTrickle } from "@/lib/rtc/trickle";
import type { IceTrickle } from "@/lib/rtc/trickle";
import { clearTvIp, readTvIp, writeTvIp } from "@/lib/rtc/tv-ip";
import type { ControlMessage } from "@/lib/transfer/protocol";

type PhoneState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "confirming"; confirmation: string; channelReady: boolean; tvReady: boolean }
  | { phase: "connected"; deviceName: string }
  | { phase: "error"; title: string; message: string; showIpFallback?: boolean };

interface PhoneSenderProps {
  initialCode: string;
}

export function PhoneSender({ initialCode }: PhoneSenderProps) {
  const [codeInput, setCodeInput] = useState(initialCode);
  const [state, setState] = useState<PhoneState>({ phase: "idle" });
  const [savedIp, setSavedIp] = useState<string | null>(() => readTvIp());
  const [ipDraft, setIpDraft] = useState<string>(() => readTvIp() ?? "");
  const [ipStatus, setIpStatus] = useState<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const controlRef = useRef<RTCDataChannel | null>(null);
  const dataRef = useRef<RTCDataChannel | null>(null);
  const tvNameRef = useRef("TV");
  const mountedRef = useRef(true);
  const connectingRef = useRef(false);
  const attemptRef = useRef(0);
  const lastErrorRef = useRef<string | null>(null);
  const trackerRef = useRef<PeerTracker | null>(null);
  const trickleRef = useRef<IceTrickle | null>(null);
  const configuredTurnRef = useRef(0);
  const stopChannelTrackingRef = useRef<Array<() => void>>([]);
  const offerReportRef = useRef<CandidateReport | null>(null);
  const answerReportRef = useRef<CandidateReport | null>(null);
  const phaseRef = useRef<DiagnosticPhase>("remote-description");
  const firstErrorRef = useRef<DiagnosticError | null>(null);
  const startedAtRef = useRef(0);
  const log = useMemo(() => createLogger("phone", "phone"), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attemptRef.current += 1;
      phaseRef.current = "closed";
      trickleRef.current?.stop();
      trickleRef.current = null;
      trackerRef.current?.stop();
      trackerRef.current = null;
      for (const stop of stopChannelTrackingRef.current) stop();
      stopChannelTrackingRef.current = [];
      pcRef.current?.close();
      pcRef.current = null;
    };
  }, []);

  const update = (next: PhoneState) => {
    if (mountedRef.current) setState(next);
  };

  const reset = () => {
    phaseRef.current = "closed";
    trickleRef.current?.stop();
    trickleRef.current = null;
    trackerRef.current?.stop();
    trackerRef.current = null;
    for (const stop of stopChannelTrackingRef.current) stop();
    stopChannelTrackingRef.current = [];
    pcRef.current?.close();
    pcRef.current = null;
    controlRef.current = null;
    dataRef.current = null;
    tvNameRef.current = "TV";
    connectingRef.current = false;
  };

  /**
   * Captures ICE evidence before the peer is closed. Resetting first (the old
   * order) produced an empty snapshot and hid the real failure.
   */
  const finalizeFailure = async (failure: { title: string; message: string; event: string }) => {
    if (!firstErrorRef.current) {
      firstErrorRef.current = {
        event: failure.event,
        detail: `${failure.title}: ${failure.message}`,
      };
    }

    const pc = pcRef.current;
    const tracker = trackerRef.current;
    const ice = trickleRef.current?.counts() ?? null;

    if (pc && tracker) {
      const channels = [controlRef.current, dataRef.current].filter(
        (channel): channel is RTCDataChannel => channel !== null,
      );

      try {
        const { snapshot, report } = await capturePeerDiagnostics({
          role: "phone",
          phase: phaseRef.current,
          pc,
          channels,
          local: tracker.counts(),
          trickle: ice,
          configuredTurn: configuredTurnRef.current,
          signalingLost: ice?.signalingLost ?? false,
          firstError: firstErrorRef.current,
          elapsedMs: Date.now() - startedAtRef.current,
        });

        log.error("peer:snapshot", { peer: snapshot });
        log.error("diagnostics:report", report);
        if (report.case !== "OK") {
          log.warn("diagnostics:case", { case: report.case, title: report.title });
        }
      } catch (error) {
        log.warn("diagnostics:failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }

    reset();
  };

  const handleControlMessage = (message: ControlMessage) => {
    log.info("control:message", { type: message.t, role: "role" in message ? message.role : null });

    if (message.t === "HELLO") {
      tvNameRef.current = message.name;
      if (message.role === "tv" && mountedRef.current) {
        setState((current) =>
          current.phase === "confirming" ? { ...current, tvReady: true } : current,
        );
      }
    }
  };

  const connect = async (rawCode: string) => {
    const code = rawCode.trim();
    if (!/^\d{4}$/.test(code)) {
      log.warn("code:invalid", { length: code.length });
      update({
        phase: "error",
        title: "Could not connect",
        message: "Enter the 4-digit code shown on the TV.",
      });
      return;
    }

    if (connectingRef.current) {
      log.warn("connect:ignored-while-busy");
      return;
    }

    reset();
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    connectingRef.current = true;
    lastErrorRef.current = null;
    firstErrorRef.current = null;
    phaseRef.current = "remote-description";
    startedAtRef.current = Date.now();
    update({ phase: "connecting" });
    log.mark("attempt:start", { attempt, code });
    const iceServers = summarizeIceServers(getIceServers());
    configuredTurnRef.current = iceServers.turn;
    log.info("session:env", {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      secureContext: window.isSecureContext,
      hasPeerConnection: typeof RTCPeerConnection === "function",
      origin: window.location.origin,
      iceServers,
    });

    const isCurrent = () => mountedRef.current && attemptRef.current === attempt;

    try {
      // A token created before the first claim makes a reload before the
      // answer idempotent: the same phone reclaims its room instead of seeing
      // CLAIMED. After the answer is posted the retry is rejected cleanly.
      const storedClaimToken = readClaimToken(code);
      const claimToken = storedClaimToken ?? createClaimToken();
      writeClaimToken(code, claimToken);
      log.info("claim:token", { reused: storedClaimToken !== null });

      const claimed = await withRetry(() => claimRoom(code, claimToken));
      if (!isCurrent()) return;
      const { offer } = claimed;
      writeClaimToken(code, claimed.claimToken);
      log.mark("room:claimed", { code });

      const offerReport = analyzeSdp(offer.sdp ?? "");
      offerReportRef.current = offerReport;
      log.info("offer:received", { candidates: offerReport });

      // Fix 5: if the TV only offered mDNS (.local) candidates and the user
      // stored its LAN IP, rewrite them so we can actually reach it.
      const storedIp = readTvIp();
      let remoteOffer = offer;
      if (storedIp && offerReport.mdns > 0) {
        const rewrite = rewriteMdnsCandidates(offer.sdp ?? "", storedIp);
        if (rewrite.rewritten > 0) {
          log.warn("offer:mdns-rewritten", { ip: storedIp, candidates: rewrite.rewritten });
          remoteOffer = { ...offer, sdp: rewrite.sdp };
        }
      }

      const pc = createPeerConnection();
      pcRef.current = pc;
      trackerRef.current = trackPeerConnection(pc, log.child("rtc"));
      log.mark("pc:created");

      const trickle = createIceTrickle({
        pc,
        log: log.child("ice"),
        transport: {
          post: (candidates, complete) =>
            postCandidates(code, { claimToken }, candidates, complete),
          get: (since) => getCandidates(code, { claimToken }, since),
        },
      });
      trickleRef.current = trickle;
      // Capture before the answer exists and start polling now: the TV's
      // candidates are kept in a queue until setRemoteDescription resolves.
      trickle.capture();
      trickle.pollRemote();

      pc.addEventListener("iceconnectionstatechange", () => {
        if (pc.iceConnectionState === "checking" && phaseRef.current === "remote-description") {
          phaseRef.current = "checking";
        }
      });

      pc.addEventListener("connectionstatechange", () => {
        if (!isCurrent() || pc.connectionState !== "failed") return;

        const explanation = explainConnectionFailure({
          snapshot: null,
          local: answerReportRef.current,
          remote: offerReportRef.current,
        });
        lastErrorRef.current = explanation.message;
        log.error("state:error", { ...explanation, reason: "connectionstatechange" });

        update({
          phase: "error",
          title: explanation.title,
          message: explanation.message,
          showIpFallback: true,
        });
        void finalizeFailure({
          title: explanation.title,
          message: explanation.message,
          event: "connectionstatechange:failed",
        });
      });

      let control: RTCDataChannel | null = null;
      let data: RTCDataChannel | null = null;

      const channelsReady = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("The TV did not open the data channels in time.")),
          20_000,
        );

        pc.ondatachannel = (event) => {
          if (!isCurrent()) return;
          const channel = event.channel;
          log.info("channel:arrived", { label: channel.label });
          stopChannelTrackingRef.current.push(trackDataChannel(channel, log.child("rtc")));

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
            dataRef.current = channel;
          }
          if (control && data) {
            clearTimeout(timer);
            resolve();
          }
        };
      });

      const answer = await createAnswer(pc, remoteOffer);
      if (!isCurrent()) return;
      phaseRef.current = "checking";

      const answerReport = analyzeSdp(answer.sdp ?? "");
      answerReportRef.current = answerReport;
      log.info("answer:created", { candidates: answerReport });
      if (answerReport.verdict !== "usable") {
        log.warn("answer:no-usable-candidate", { candidates: answerReport });
      }

      // The offer is now the remote description, so queued TV candidates are
      // safe to add. Local candidates start flowing right after.
      await trickle.applyRemote();
      trickle.start();
      log.info("trickle:counts", { counts: trickle.counts() });

      await withRetry(() => postAnswer(code, answer, claimToken));
      if (!isCurrent()) return;
      log.mark("answer:posted");

      const confirmation = await confirmationCode(offer.sdp ?? "", answer.sdp ?? "");
      if (!isCurrent()) return;
      log.info("confirm:code", { confirmation });
      phaseRef.current = "channel-wait";
      update({ phase: "confirming", confirmation, channelReady: false, tvReady: false });
      log.mark("state:confirming");

      await channelsReady;
      if (!isCurrent()) return;
      if (!control || !data) throw new Error("The TV did not open the data channels.");
      log.info("channels:arrived");

      await Promise.all([waitForChannelOpen(control), waitForChannelOpen(data)]);
      if (!isCurrent()) return;
      log.info("channels:open");
      // ICE is done: both channels are open, so stop posting/polling.
      trickle.stop();

      sendControl(control, { t: "HELLO", role: "phone", name: getDeviceName() });
      log.info("control:hello-sent", { name: getDeviceName() });

      setState((current) =>
        current.phase === "confirming" ? { ...current, channelReady: true } : current,
      );
    } catch (error) {
      if (!isCurrent()) return;

      // A concrete ICE failure already reported itself. Do not let a later
      // channel timeout overwrite it, and do not capture the peer twice.
      if (lastErrorRef.current) return;

      if (error instanceof ApiError) {
        const api = describeApiError(error);
        if (api.clearClaimToken) clearClaimToken(code);

        lastErrorRef.current = api.message;
        log.error("state:error", {
          title: api.title,
          message: api.message,
          code: error.code,
        });

        update({ phase: "error", title: api.title, message: api.message });
        await finalizeFailure({
          title: api.title,
          message: api.message,
          event: "connect:api-error",
        });
        return;
      }

      const explanation = failureFromError(
        error,
        answerReportRef.current,
        offerReportRef.current,
      );
      const message = explanation?.message ?? "Could not connect.";
      const title = explanation?.title ?? "Could not connect";

      lastErrorRef.current = message;
      log.error("state:error", { title, message, error });

      update({ phase: "error", title, message, showIpFallback: true });
      await finalizeFailure({ title, message, event: "connect:error" });
    } finally {
      if (attemptRef.current === attempt) connectingRef.current = false;
    }
  };

  const confirm = () => {
    const control = controlRef.current;
    if (!control || control.readyState !== "open") {
      log.warn("user:confirm:no-channel", { readyState: control?.readyState ?? "missing" });
      return;
    }
    log.mark("user:confirm");
    sendControl(control, { t: "CONFIRM" });
    log.info("control:confirm-sent");
    phaseRef.current = "connected";
    update({ phase: "connected", deviceName: tvNameRef.current });
  };

  const reject = () => {
    const control = controlRef.current;
    if (control?.readyState === "open") {
      sendControl(control, { t: "REJECT", reason: "mismatch" });
      log.warn("control:reject-sent");
    }

    // Invalidate the in-flight attempt so a late timeout cannot overwrite this state.
    attemptRef.current += 1;
    reset();
    update({
      phase: "error",
      title: "Codes did not match",
      message: "The connection was closed. Show a new code on the TV and try again.",
    });
  };

  const retry = () => {
    reset();
    setState({ phase: "idle" });
  };

  const handleIpSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = ipDraft.trim();
    if (!isValidIPv4(value)) {
      setIpStatus("Enter a valid IPv4 address, for example 192.168.43.10.");
      return;
    }

    writeTvIp(value);
    setSavedIp(value);
    setIpStatus(null);
    log.mark("tv-ip:saved", { ip: value });
    void connect(codeInput);
  };

  const handleIpClear = () => {
    clearTvIp();
    setSavedIp(null);
    setIpDraft("");
    setIpStatus(null);
    log.mark("tv-ip:cleared");
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
    const ready = state.channelReady && state.tvReady;

    return (
      <StatusScreen title="Check the code">
        <ConfirmCode
          code={state.confirmation}
          onMatch={confirm}
          onMismatch={reject}
          disabled={!ready}
        />
        <p className="text-sm text-zinc-500" role="status">
          {ready
            ? "Both screens show the same code."
            : state.channelReady
              ? "Waiting for the TV to show the code..."
              : "Waiting for the data channel..."}
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
    <StatusScreen title={state.title} message={state.message}>
      {state.showIpFallback ? (
        <form
          className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4"
          onSubmit={handleIpSubmit}
        >
          <label htmlFor="tv-ip" className="text-left text-sm text-zinc-400">
            Advanced: if this keeps failing, enter the TV&apos;s IP address (TV Settings → Network →
            IP address). The hidden .local address is often blocked on a hotspot.
          </label>
          <input
            id="tv-ip"
            value={ipDraft}
            onChange={(event) => setIpDraft(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            placeholder="192.168.43.10"
            className="w-full rounded-xl border-2 border-zinc-700 bg-zinc-950 px-4 py-3 font-mono text-xl text-white focus:border-emerald-400 focus:outline-none"
          />
          {ipStatus ? (
            <p className="text-sm text-amber-300" role="alert">
              {ipStatus}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <TvButton type="submit" disabled={!isValidIPv4(ipDraft)}>
              Retry with this IP
            </TvButton>
            {savedIp ? (
              <TvButton type="button" variant="secondary" onClick={handleIpClear}>
                Clear saved IP
              </TvButton>
            ) : null}
          </div>
        </form>
      ) : null}
      <TvButton onClick={retry}>Try again</TvButton>
    </StatusScreen>
  );
}

function failureFromError(
  error: unknown,
  local: CandidateReport | null,
  remote: CandidateReport | null,
): { title: string; message: string } {
  const raw = error instanceof Error ? error.message : "Could not connect.";

  if (/did not open the data channels|did not open in time|closed before opening/i.test(raw)) {
    return explainConnectionFailure({ snapshot: null, local, remote });
  }

  return { title: "Could not connect", message: raw };
}

/** Room errors are not network failures; each has a specific recovery step. */
function describeApiError(error: ApiError): {
  title: string;
  message: string;
  clearClaimToken: boolean;
} {
  switch (error.code) {
    case "ANSWER_EXISTS":
      return {
        title: "Code already used",
        message: "This code was already used. Show a new code on the TV and scan it again.",
        clearClaimToken: true,
      };
    case "CLAIMED":
      return {
        title: "Code already used",
        message: "This code has already been claimed. Show a new code on the TV.",
        clearClaimToken: true,
      };
    case "NOT_FOUND":
      return {
        title: "Code expired",
        message: "This code is no longer valid. Show a new code on the TV.",
        clearClaimToken: true,
      };
    case "RATE_LIMITED":
      return {
        title: "Too many attempts",
        message: "Wait a moment, then enter the code again.",
        clearClaimToken: false,
      };
    case "INVALID":
      return {
        title: "Could not connect",
        message: error.message,
        clearClaimToken: true,
      };
    default:
      return {
        title: "Could not connect",
        message: error.message,
        clearClaimToken: false,
      };
  }
}
