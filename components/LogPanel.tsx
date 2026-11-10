"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  clearLogs,
  getLogs,
  getServerLogs,
  installGlobalHandlers,
  logsAsJson,
  logsAsText,
  subscribeLogs,
} from "@/lib/log/logger";
import { uploadLogs } from "@/lib/log/sink";
import type { LogLevel, LogRole } from "@/lib/log/types";

interface LogPanelProps {
  role: LogRole;
}

const LEVEL_STYLES: Record<LogLevel, string> = {
  debug: "text-zinc-500",
  info: "text-emerald-300",
  warn: "text-amber-300",
  error: "text-red-400",
};

export function LogPanel({ role }: LogPanelProps) {
  const entries = useSyncExternalStore(subscribeLogs, getLogs, getServerLogs);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    installGlobalHandlers(role);
  }, [role]);

  const handleUpload = async (): Promise<void> => {
    setStatus("Uploading…");
    const result = await uploadLogs(getLogs(), role);
    if (!result) {
      setStatus("Upload failed. Check the network and retry.");
      return;
    }

    setStatus(
      result.stored
        ? `Log id ${result.id} — open /logs/${result.id} on your phone.`
        : `Log id ${result.id} (server storage unavailable — see the Vercel log).`,
    );
  };

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(logsAsText());
      setStatus("Log copied.");
    } catch {
      setStatus("Copy failed. Use Download instead.");
    }
  };

  const handleDownload = (): void => {
    const blob = new Blob([logsAsJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ft-log-${role}-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("Log downloaded.");
  };

  const recent = entries.slice(-120).reverse();

  return (
    <div className="fixed inset-x-3 bottom-3 z-50 flex flex-col items-start gap-2 text-left">
      {open ? (
        <section
          aria-label="Diagnostics log"
          className="w-full max-w-2xl rounded-2xl border border-zinc-700 bg-zinc-900/95 p-3 shadow-2xl backdrop-blur"
        >
          <header className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-white">
              Diagnostics · {entries.length} entries
            </h2>
            <div className="flex flex-wrap gap-2">
              <PanelButton onClick={() => void handleUpload()}>Upload</PanelButton>
              <PanelButton onClick={() => void handleCopy()}>Copy</PanelButton>
              <PanelButton onClick={handleDownload}>Download</PanelButton>
              <PanelButton onClick={() => { clearLogs(); setStatus("Log cleared."); }}>Clear</PanelButton>
            </div>
          </header>

          {status ? (
            <p role="status" className="mt-2 text-xs text-emerald-300">
              {status}
            </p>
          ) : null}

          <ol className="mt-2 max-h-[45vh] overflow-y-auto font-mono text-[11px] leading-4">
            {recent.length === 0 ? (
              <li className="py-2 text-zinc-500">No entries yet.</li>
            ) : (
              recent.map((entry) => (
                <li key={`${entry.sessionId}-${entry.seq}`} className="border-b border-zinc-800/70 py-1">
                  <span className="text-zinc-500">+{(entry.tPlus / 1000).toFixed(2)}s </span>
                  <span className={LEVEL_STYLES[entry.level]}>{entry.level} </span>
                  <span className="text-zinc-500">{entry.scope} </span>
                  <span className="text-zinc-200">{entry.event}</span>
                  {entry.data === undefined ? null : (
                    <pre className="whitespace-pre-wrap break-all text-zinc-400">
                      {JSON.stringify(entry.data)}
                    </pre>
                  )}
                </li>
              ))
            )}
          </ol>
        </section>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="min-h-10 rounded-full border border-zinc-700 bg-zinc-900/90 px-4 text-sm font-medium text-zinc-300 shadow-lg backdrop-blur transition hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
      >
        {open ? "Hide logs" : `Logs (${entries.length})`}
      </button>
    </div>
  );
}

function PanelButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-zinc-700 px-2 py-1 text-xs font-medium text-zinc-200 transition hover:border-zinc-500 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
    >
      {children}
    </button>
  );
}
