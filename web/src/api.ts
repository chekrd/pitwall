import type { ActionBody, ActionName, ActionResponse, BodyArgs, Method, Paths, Responses, RouteAt, RouteBody } from '../../server/contract.ts';
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

interface Options {
  keepalive?: boolean;
}

async function request(method: string, path: string, body?: unknown, { keepalive = false }: Options = {}): Promise<unknown> {
  if (method !== 'GET') track('api', { method, path: path.split('?')[0].replace(/\/(?:[0-9a-f-]{8,}|\d+)(?=\/|$)/g, '/:id') });
  // Every change goes as JSON, also one without a body: the server refuses other types, which a cross-site form can send.
  const json = method === 'GET' ? undefined : (body ?? {});
  const res = await fetch(path, {
    method,
    headers: json === undefined ? {} : { 'content-type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json),
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
  return res.status === 204 ? undefined : res.json();
}

// Typed by the route the path names, from server/contract.ts.
export const api = <M extends Method, P extends Paths<M>>(method: M, path: P, ...[body, options]: BodyArgs<RouteBody<RouteAt<M, P>>, Options>) =>
  request(method, path, body, options) as Promise<Responses[RouteAt<M, P>]>;

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

type Bodiless = { [A in ActionName]: {} extends ActionBody<A> ? A : never }[ActionName];

export function sessionAction<A extends Bodiless>(id: string, action: A): Promise<ActionResponse<A>>;
export function sessionAction<A extends ActionName>(id: string, action: A, body: ActionBody<A>, options?: Options): Promise<ActionResponse<A>>;
export function sessionAction(id: string, action: ActionName, body?: unknown, options?: Options) {
  return request('POST', `/api/sessions/${id}/${action}`, body ?? {}, options);
}
