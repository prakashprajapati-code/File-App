"use client";

import type { ButtonHTMLAttributes } from "react";

interface TvButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
}

export function TvButton({ variant = "primary", className = "", ...props }: TvButtonProps) {
  const styles =
    variant === "primary"
      ? "bg-emerald-500 text-black hover:bg-emerald-400"
      : "bg-zinc-800 text-white hover:bg-zinc-700";

  return (
    <button
      {...props}
      className={`min-h-12 rounded-2xl px-8 py-3 text-xl font-semibold transition focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-emerald-400 disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  );
}
