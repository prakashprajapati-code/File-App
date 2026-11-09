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
  const response = await fetch(input, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const body = await readJson<T>(response);
  throwIfFailed(response, body);
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
  const response = await fetch(`/api/rooms/${encodeURIComponent(code)}/answer`, {
    headers: { "x-token": token },
  });

  if (response.status === 204) return null;

  const body = await readJson<{ answer: RTCSessionDescriptionInit }>(response);
  throwIfFailed(response, body);
  return (body as ApiSuccess<{ answer: RTCSessionDescriptionInit }>).data.answer;
}

export function deleteRoom(code: string, token: string): Promise<void> {
  return request(`/api/rooms/${encodeURIComponent(code)}`, {
    method: "DELETE",
    headers: { "x-token": token },
  });
}
