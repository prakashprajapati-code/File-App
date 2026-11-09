import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-10 bg-zinc-950 px-6 py-16 text-center text-white">
      <div className="flex max-w-2xl flex-col gap-4">
        <h1 className="text-5xl font-bold sm:text-6xl">Phone &rarr; TV</h1>
        <p className="text-lg text-zinc-400">
          Send a file from your phone to the TV over your local Wi-Fi. The file never
          goes through the internet.
        </p>
      </div>
      <div className="flex w-full max-w-md flex-col gap-4 sm:flex-row">
        <Link
          href="/tv"
          className="flex min-h-12 flex-1 items-center justify-center rounded-2xl bg-emerald-500 px-8 py-3 text-xl font-semibold text-black transition hover:bg-emerald-400 focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-emerald-400"
        >
          I&apos;m the TV
        </Link>
        <Link
          href="/send"
          className="flex min-h-12 flex-1 items-center justify-center rounded-2xl bg-zinc-800 px-8 py-3 text-xl font-semibold text-white transition hover:bg-zinc-700 focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-emerald-400"
        >
          I&apos;m the phone
        </Link>
      </div>
    </main>
  );
}
