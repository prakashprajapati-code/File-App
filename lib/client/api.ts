import { createLogger } from "@/lib/log/logger";
import type { LogRole } from "@/lib/log/types";

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: { code: string; message: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function detectRole(): LogRole {
  if (typeof window === "undefined") return "unknown";
  const path = window.location.pathname;
  if (path.startsWith("/tv")) return "tv";
  if (path.startsWith("/send")) return "phone";
  return "unknown";
}

const log = createLogger("api", detectRole());

async function readJson<T>(response: Response): Promise<ApiSuccess<T> | ApiFailure | null> {
  try {
    return (await response.json()) as ApiSuccess<T> | ApiFailure;
  } catch {
    return null;
  }
}

function throwIfFailed(response: Response, body: ApiSuccess<unknown> | ApiFailure | null): void {
  if (response.ok && body && body.ok) return;

  const error = body && !body.ok ? body.error : { code: "NETWORK", message: "Request failed." };
  throw new ApiError(response.status, error.code, error.message);
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  const startedAt = Date.now();

  log.debug("request:start", { method, path: input });

  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    log.error("request:network-error", {
      method,
      path: input,
      ms: Date.now() - startedAt,
      error,
    });
    throw error;
  }

  if (response.status === 204) {
    log.info("request:empty", { method, path: input, status: 204, ms: Date.now() - startedAt });
    return undefined as T;
  }

  const body = await readJson<T>(response);

  try {
    throwIfFailed(response, body);
  } catch (error) {
    log.error("request:failed", {
      method,
      path: input,
      status: response.status,
      code: error instanceof ApiError ? error.code : "UNKNOWN",
      ms: Date.now() - startedAt,
    });
    throw error;
  }

  log.info("request:ok", { method, path: input, status: response.status, ms: Date.now() - startedAt });
  return (body as ApiSuccess<T>).data;
}

export function createRoom(offer: RTCSessionDescriptionInit): Promise<{ code: string; token: string }> {
  return request("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ offer }),
  });
}

export function claimRoom(
  code: string,
): Promise<{ offer: RTCSessionDescriptionInit; claimToken: string }> {
  return request(`/api/rooms/${encodeURIComponent(code)}`);
}

export function postAnswer(
  code: string,
  answer: RTCSessionDescriptionInit,
  claimToken: string,
): Promise<void> {
  return request(`/api/rooms/${encodeURIComponent(code)}/answer`, {
    method: "POST",
    headers: { "x-claim-token": claimToken },
    body: JSON.stringify({ answer }),
  });
}

export async function getAnswer(
  code: string,
  token: string,
): Promise<RTCSessionDescriptionInit | null> {
  const path = `/api/rooms/${encodeURIComponent(code)}/answer`;
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(path, { headers: { "x-token": token } });
  } catch (error) {
    log.error("request:network-error", { method: "GET", path, ms: Date.now() - startedAt, error });
    throw error;
  }

  if (response.status === 204) {
    log.debug("request:empty", { method: "GET", path, status: 204, ms: Date.now() - startedAt });
    return null;
  }

  const body = await readJson<{ answer: RTCSessionDescriptionInit }>(response);

  try {
    throwIfFailed(response, body);
  } catch (error) {
    log.error("request:failed", {
      method: "GET",
      path,
      status: response.status,
      code: error instanceof ApiError ? error.code : "UNKNOWN",
      ms: Date.now() - startedAt,
    });
    throw error;
  }

  log.info("request:ok", {
    method: "GET",
    path,
    status: response.status,
    ms: Date.now() - startedAt,
  });
  return (body as ApiSuccess<{ answer: RTCSessionDescriptionInit }>).data.answer;
}

export function deleteRoom(code: string, token: string): Promise<void> {
  return request(`/api/rooms/${encodeURIComponent(code)}`, {
    method: "DELETE",
    headers: { "x-token": token },
  });
}
