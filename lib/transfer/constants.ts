/** 16 KiB default. Benchmark 32 and 64 KiB on the real TV before changing. */
export const CHUNK_SIZE = 16 * 1024;

/** Pause sending when the data channel has this much queued locally. */
export const HIGH_WATER = 1024 * 1024;

/** Resume sending when bufferedAmount drops below this. */
export const LOW_WATER = 512 * 1024;

/** Maximum bytes sent but not yet acknowledged by the TV. */
export const WINDOW = 8 * 1024 * 1024;

/** Send an ACK after this many bytes have been written to disk. */
export const ACK_EVERY = 1024 * 1024;

/** How long the phone waits for ACCEPT after sending META. */
export const ACCEPT_TIMEOUT_MS = 30_000;

/** How long the phone waits for COMPLETE after sending DONE. */
export const COMPLETE_TIMEOUT_MS = 60_000;

/** OPFS directory that holds `.part` files. */
export const OPFS_DIR = "transfers";
