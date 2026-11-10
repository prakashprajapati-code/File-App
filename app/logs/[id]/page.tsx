import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readClientLog } from "@/lib/server/log-store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Client log",
  robots: { index: false, follow: false },
};

const LOG_ID_PATTERN = /^[a-z0-9]{6,32}$/;

const LEVEL_STYLES: Record<string, string> = {
  debug: "text-zinc-500",
  info: "text-emerald-300",
  warn: "text-amber-300",
  error: "text-red-400",
};

export default async function ClientLogPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!LOG_ID_PATTERN.test(id)) notFound();

  const payload = await readClientLog(id);
  if (!payload) notFound();

  return (
    <main className="min-h-dvh bg-zinc-950 px-4 py-8 text-zinc-200">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-white">Client log</h1>
          <p className="text-sm text-zinc-400">
            {payload.role} · {payload.entries.length} entries · saved{" "}
            {new Date(payload.savedAt).toLocaleString()}
          </p>
        </header>

        <ol className="flex flex-col gap-1 font-mono text-xs">
          {payload.entries.map((entry) => (
            <li
              key={`${entry.sessionId}-${entry.seq}`}
              className="rounded border border-zinc-800 bg-zinc-900/60 p-2"
            >
              <div className="flex flex-wrap gap-2 text-zinc-500">
                <span>+{(entry.tPlus / 1000).toFixed(3)}s</span>
                <span className={LEVEL_STYLES[entry.level] ?? "text-zinc-300"}>{entry.level}</span>
                <span>
                  {entry.role}/{entry.scope}
                </span>
              </div>
              <div className="text-zinc-200">{entry.event}</div>
              {entry.data === undefined ? null : (
                <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] text-zinc-400">
                  {JSON.stringify(entry.data, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}
