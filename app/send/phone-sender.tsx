"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ConfirmCode } from "@/components/ConfirmCode";
import { StatusScreen } from "@/components/StatusScreen";
import { TvButton } from "@/components/TvButton";
import { ApiError, claimRoom, postAnswer } from "@/lib/client/api";
import { createLogger } from "@/lib/log/logger";
import { explainConnectionFailure, snapshotPeer, trackPeerConnection } from "@/lib/log/webrtc";
import { analyzeSdp, isValidIPv4, rewriteMdnsCandidates } from "@/lib/rtc/candidates";
import type { CandidateReport } from "@/lib/rtc/candidates";
import { getDeviceName } from "@/lib/rtc/device";
import {
  createAnswer,
  createPeerConnection,
  parseControl,
  sendControl,
  waitForChannelOpen,
} from "@/lib/rtc/peer";
import { confirmationCode } from "@/lib/rtc/sdp";
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
  const tvNameRef = useRef("TV");
  const mountedRef = useRef(true);
  const connectingRef = useRef(false);
  const attemptRef = useRef(0);
  const lastErrorRef = useRef<string | null>(null);
  const stopTrackingRef = useRef<(() => void) | null>(null);
  const offerReportRef = useRef<CandidateReport | null>(null);
  const answerReportRef = useRef<CandidateReport | null>(null);
  const log = useMemo(() => createLogger("phone", "phone"), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attemptRef.current += 1;
      stopTrackingRef.current?.();
      stopTrackingRef.current = null;
      pcRef.current?.close();
      pcRef.current = null;
    };
  }, []);

  const update = (next: PhoneState) => {
    if (mountedRef.current) setState(next);
  };

  const reset = () => {
    stopTrackingRef.current?.();
    stopTrackingRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    controlRef.current = null;
    tvNameRef.current = "TV";
    connectingRef.current = false;
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
    update({ phase: "connecting" });
    log.mark("attempt:start", { attempt, code });

    const isCurrent = () => mountedRef.current && attemptRef.current === attempt;

    try {
      const { offer, claimToken } = await claimRoom(code);
      if (!isCurrent()) return;
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
      stopTrackingRef.current = trackPeerConnection(pc, log.child("rtc"));
      log.mark("pc:created");

      pc.addEventListener("connectionstatechange", () => {
        if (!isCurrent() || pc.connectionState !== "failed") return;

        const explanation = explainConnectionFailure({
          snapshot: null,
          local: answerReportRef.current,
          remote: offerReportRef.current,
        });
        lastErrorRef.current = explanation.message;
        log.error("state:error", { ...explanation, reason: "connectionstatechange" });
        void snapshotPeer(pc, controlRef.current ? [controlRef.current] : [])
          .then((snapshot) => log.error("peer:snapshot", { peer: snapshot }))
          .catch(() => undefined);

        update({
          phase: "error",
          title: explanation.title,
          message: explanation.message,
          showIpFallback: true,
        });
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
          if (!isCurrent()) return;
          const channel = event.channel;
          log.info("channel:arrived", { label: channel.label });

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

      const answer = await createAnswer(pc, remoteOffer);
      if (!isCurrent()) return;

      const answerReport = analyzeSdp(answer.sdp ?? "");
      answerReportRef.current = answerReport;
      log.info("answer:created", { candidates: answerReport });
      if (answerReport.verdict !== "usable") {
        log.warn("answer:no-usable-candidate", { candidates: answerReport });
      }

      await postAnswer(code, answer, claimToken);
      if (!isCurrent()) return;
      log.mark("answer:posted");

      const confirmation = await confirmationCode(offer.sdp ?? "", answer.sdp ?? "");
      if (!isCurrent()) return;
      log.info("confirm:code", { confirmation });
      update({ phase: "confirming", confirmation, channelReady: false, tvReady: false });
      log.mark("state:confirming");

      await channelsReady;
      if (!isCurrent()) return;
      if (!control || !data) throw new Error("The TV did not open the data channels.");
      log.info("channels:arrived");

      await Promise.all([waitForChannelOpen(control), waitForChannelOpen(data)]);
      if (!isCurrent()) return;
      log.info("channels:open");

      sendControl(control, { t: "HELLO", role: "phone", name: getDeviceName() });
      log.info("control:hello-sent", { name: getDeviceName() });

      setState((current) =>
        current.phase === "confirming" ? { ...current, channelReady: true } : current,
      );
    } catch (error) {
      if (!isCurrent()) return;

      const isApiError = error instanceof ApiError;
      const explanation = isApiError
        ? null
        : failureFromError(error, answerReportRef.current, offerReportRef.current);
      const message =
        lastErrorRef.current ??
        (isApiError ? error.message : (explanation?.message ?? "Could not connect."));
      const title = explanation?.title ?? "Could not connect";

      log.error("state:error", {
        title,
        message,
        code: isApiError ? error.code : null,
        error,
      });

      reset();
      update({ phase: "error", title, message, showIpFallback: !isApiError });
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
    connectingRef.current = false;
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
