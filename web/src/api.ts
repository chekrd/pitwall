import { record } from './recorder.ts';
import { track } from './ux.ts';

export const wsUrl = (path: string) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;

// A refusal keeps the server's code ('stale', 'answered', …), so callers can tell refusals apart.
export interface ApiError extends Error {
  code?: string;
  status: number;
}

// Still a TypeError, which the outbox reads as "try again once the link is back".
const unreachable = () => Object.assign(new TypeError('Pitwall could not be reached; it may be restarting. Try again in a moment.'), { code: 'unreachable', status: 0 });

export async function api<T = void>(method: string, path: string, body?: unknown, { keepalive = false } = {}): Promise<T> {
  if (method !== 'GET') track('api', { method, path: path.split('?')[0].replace(/\/(?:[0-9a-f-]{8,}|\d+)(?=\/|$)/g, '/:id') });
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive,
  }).catch((err: unknown) => {
    record('api-failed', { method, path, error: String(err) });
    throw err instanceof TypeError ? unreachable() : err;
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    record('api-failed', { method, path, status: res.status, error: err.error ?? res.statusText, code: err.code ?? null });
    const failure: ApiError = Object.assign(new Error(err.error ?? res.statusText), { code: err.code as string | undefined, status: res.status });
    throw failure;
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export async function upload(file: File) {
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name || 'pasted') },
    body: file,
  }).catch((err: unknown) => {
    record('api-failed', { method: 'POST', path: '/api/uploads', error: String(err) });
    throw err instanceof TypeError ? unreachable() : err;
  });
  const out = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(out.error ?? res.statusText);
  return out.path as string;
}

export const sessionAction = (id: string, action: string, body?: unknown, options?: { keepalive?: boolean }) =>
  api('POST', `/api/sessions/${id}/${action}`, body ?? {}, options);
