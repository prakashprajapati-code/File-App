import type { ReactNode } from "react";

interface StatusScreenProps {
  title: string;
  message?: string;
  children?: ReactNode;
}

export function StatusScreen({ title, message, children }: StatusScreenProps) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-zinc-950 px-6 py-12 text-center text-white">
      <div className="flex max-w-2xl flex-col gap-3">
        <h1 className="text-4xl font-bold sm:text-5xl">{title}</h1>
        {message ? <p className="text-lg text-zinc-400">{message}</p> : null}
      </div>
      {children}
    </main>
  );
}
