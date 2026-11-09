"use client";

import { TvButton } from "./TvButton";

interface ConfirmCodeProps {
  code: string;
  onMatch?: () => void;
  onMismatch?: () => void;
  disabled?: boolean;
}

export function ConfirmCode({ code, onMatch, onMismatch, disabled = false }: ConfirmCodeProps) {
  return (
    <section className="flex flex-col items-center gap-6" aria-labelledby="confirm-heading">
      <h2 id="confirm-heading" className="text-xl text-zinc-400">
        Does this code match the other screen?
      </h2>
      <p
        className="font-mono text-6xl font-bold tracking-[0.2em] text-white sm:text-7xl"
        aria-label={`Confirmation code ${code.split("").join(" ")}`}
      >
        {code}
      </p>
      {onMatch ? (
        <div className="flex flex-wrap justify-center gap-4">
          <TvButton onClick={onMatch} disabled={disabled}>
            Matches
          </TvButton>
          <TvButton onClick={onMismatch} variant="secondary">
            Does not match
          </TvButton>
        </div>
      ) : null}
    </section>
  );
}
