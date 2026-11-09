export type ApiSuccess<T> = { ok: true; data: T };

export type ApiFailure = {
  ok: false;
  error: { code: string; message: string };
};

export function ok<T>(data: T, status = 200): Response {
  const body: ApiSuccess<T> = { ok: true, data };
  return Response.json(body, { status });
}

export function fail(code: string, message: string, status: number): Response {
  const body: ApiFailure = { ok: false, error: { code, message } };
  return Response.json(body, { status });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}
