import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { WebSocket } from 'ws';
import { createApp, socketServer, type Snapshot } from './app.ts';
import { HOST, PORT, SESSIONS_DIR } from './config.ts';
import type { Route } from './contract.ts';
import { repos, sessions } from './db.ts';
import { notify, refreshWorkspace, repoView } from './workspace.ts';

const run = promisify(execFile);

const app = createApp({ usage: { current: () => null }, ui: { settled: () => null, fresh: async () => null } });

const BOARD = `${HOST}:${PORT}`;

function call(method: string, path: string, { body, headers = {} }: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  return app.fetch(new Request(`http://${BOARD}${path}`, { method, body: body ?? null, headers: { host: BOARD, ...headers } }));
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call('POST', path, { body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

let n = 0;
function addSession(repoId: number | null = null) {
  const id = `app-test-${process.pid}-${n++}`;
  sessions.insert({ id, repoId, worktree: '/nowhere', cwd: '/nowhere', pid: null, tty: null, title: null, firstPrompt: null, status: 'idle' });
  return id;
}

test('a request naming another host is refused, as a DNS-rebinding page would send it', async () => {
  assert.equal((await call('GET', '/api/state')).status, 200);
  for (const host of ['evil.example', `evil.example:${PORT}`, `${HOST}.evil.example:${PORT}`, `${HOST}:5173`, '']) {
    assert.equal((await call('GET', '/api/state', { headers: { host } })).status, 403, host);
  }
});

test('a request from another origin is refused, also from a Vite dev server on 5173; the board itself and tools without an origin pass', async () => {
  for (const origin of ['https://evil.example', 'http://127.0.0.1:5173', 'http://localhost:5173', 'null']) {
    assert.equal((await call('GET', '/api/state', { headers: { origin } })).status, 403, origin);
  }
  assert.equal((await call('GET', '/api/state', { headers: { origin: `http://${BOARD}` } })).status, 200);
  assert.equal((await call('GET', '/api/state', { headers: { origin: `http://localhost:${PORT}` } })).status, 200);
});

test('a change sent as anything but JSON is refused before it acts, as a cross-site form or no-cors fetch could send it', async () => {
  const id = addSession();
  const json = '{"archived":true}';
  const cases: { body: BodyInit; headers?: Record<string, string> }[] = [
    { body: json, headers: { 'content-type': 'text/plain' } }, { body: json, headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    { body: json }, { body: new TextEncoder().encode(json) },
  ];
  for (const options of cases) assert.equal((await call('POST', `/api/sessions/${id}/archive`, options)).status, 415, JSON.stringify(options.headers));
  assert.equal((await call('POST', '/api/pause', { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(sessions.get(id)!.archived, false);
  assert.equal((await post(`/api/sessions/${id}/archive`, { archived: true }, { 'content-type': 'application/json; charset=utf-8' })).status, 204);
  assert.equal(sessions.get(id)!.archived, true);
});

test('an upload must name its file in x-filename, a header no simple request carries, and one over 30 MB is refused before it is read', async () => {
  const plain = await call('POST', '/api/uploads', { body: 'hello', headers: { 'content-type': 'text/plain' } });
  assert.equal(plain.status, 415);
  const big = await call('POST', '/api/uploads', { body: 'x', headers: { 'x-filename': 'a.txt', 'content-length': String(31 * 1024 * 1024) } });
  assert.equal(big.status, 413);
  const ok = await call('POST', '/api/uploads', { body: 'hello', headers: { 'content-type': 'text/plain', 'x-filename': 'a.txt' } });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).path, /a\.txt$/);
});

test('a body with fields the page does not send, such as a setup command, is a 400 and starts nothing', async () => {
  const id = await realpath(await mkdtemp(join(tmpdir(), 'app-repo-')));
  await run('git', ['init', '-q', id]);
  const repoId = repos.add(id);
  await refreshWorkspace();
  assert.ok(repoView(repoId)?.worktrees.some((w) => w.path === id));
  const before = sessions.all().length;
  for (const body of [
    { repoId, worktree: id, setup: 'touch /tmp/pwned' },
    { repoId, worktree: id, parent: { id: 'x' } },
    { repoId, worktree: id, running: { model: 'opus', effort: null } },
    { repoId: String(repoId), worktree: id },
  ]) {
    const res = await post('/api/sessions', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok((await res.json()).error);
  }
  const res = await post('/api/sessions', { repoId, worktree: '/etc' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'unknown worktree');
  assert.equal((await (await post('/api/sessions', { repoId: repoId + 1000, worktree: id })).json()).error, 'unknown repo');
  assert.equal(sessions.all().length, before);
});

test('a body that is not JSON is a 400', async () => {
  const res = await call('POST', `/api/sessions/${addSession()}/rename`, { body: '{', headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'the body is not JSON');
});

test('a refusal is a 400 with its code; a fault here is a 500', async () => {
  const id = addSession();
  const refused = await post(`/api/sessions/${id}/dismiss`, {});
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).code, 'out-of-date');
  const stale = await post(`/api/sessions/${id}/dismiss`, { key: 'q:gone' });
  assert.deepEqual([stale.status, (await stale.json()).code], [400, 'stale']);
  const error = console.error;
  console.error = () => {};
  try {
    const fault = await post('/api/sessions/no-such-session/quit', {});
    assert.equal(fault.status, 500);
    assert.equal((await fault.json()).code, undefined);
  } finally {
    console.error = error;
  }
});

test('a shell in a folder that is gone fails and opens no tab', async () => {
  const res = await post('/api/shell', { worktree: '/nonexistent/pitwall-shell' });
  assert.equal(res.status, 500);
  assert.match(await res.text(), /no longer exists/);
});

test('an unknown action is a 404, whatever its body', async () => {
  const id = addSession();
  assert.equal((await post(`/api/sessions/${id}/explode`, {})).status, 404);
  assert.equal((await post(`/api/sessions/${id}/toString`, {})).status, 404);
});

test('the server serves every route of the contract, under its method and path', () => {
  // Written out, so a route the contract gains or loses fails to compile here until the list follows.
  const contract = {
    'GET /api/state': true, 'POST /api/pick-folder': true, 'POST /api/open': true, 'POST /api/repos': true, 'DELETE /api/roots': true,
    'POST /api/rescan': true, 'PATCH /api/repos/:id': true, 'DELETE /api/repos/:id': true, 'GET /api/repos/:id/branches': true,
    'GET /api/repos/:id/models': true, 'GET /api/folders/models': true, 'POST /api/folder-tasks': true, 'POST /api/worktrees': true,
    'DELETE /api/worktrees': true, 'POST /api/schedules': true, 'PATCH /api/schedules/:id': true, 'DELETE /api/schedules/:id': true,
    'POST /api/schedules/:id/run': true, 'POST /api/sessions': true, 'POST /api/shell': true, 'GET /api/sessions/:id/conversation': true,
    'GET /api/sessions/:id/delete-worktree': true, 'POST /api/restart/resume': true, 'POST /api/restart/dismiss': true,
    'POST /api/pause': true, 'POST /api/pause/now': true, 'POST /api/pause/resume': true, 'POST /api/pause/dismiss': true,
    'POST /api/ux': true, 'POST /api/hooks/ask-user-question': true, 'POST /api/hooks/event': true, 'GET /api/commands': true,
    'GET /api/diff/file': true, 'GET /api/upstream': true, 'GET /api/diff': true,
  } satisfies Record<Route, true>;
  const served = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
  for (const route of Object.keys(contract)) assert.ok(served.has(route), route);
});

test('removing a repo drops its tasks with their folders and leaves other tasks alone', async () => {
  const repoId = repos.add(await mkdtemp(join(tmpdir(), 'app-hide-')));
  const gone = addSession(repoId);
  const kept = addSession();
  for (const id of [gone, kept]) await mkdir(join(SESSIONS_DIR, id), { recursive: true });
  assert.equal((await call('DELETE', `/api/repos/${repoId}`, { body: '{}', headers: { 'content-type': 'application/json' } })).status, 204);
  assert.equal(sessions.get(gone), undefined);
  assert.equal(existsSync(join(SESSIONS_DIR, gone)), false);
  assert.ok(sessions.get(kept));
  assert.ok(existsSync(join(SESSIONS_DIR, kept)));
});

test('every open socket gets the same snapshot on a change, and a closed one no more', async () => {
  const server = serve({ fetch: app.fetch, hostname: HOST, port: 0, websocket: { server: socketServer() } });
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const open = async () => {
    const ws = new WebSocket(`ws://${HOST}:${port}/ws/events`, { headers: { host: BOARD } });
    const messages: string[] = [];
    ws.on('message', (m) => messages.push((m as Buffer).toString()));
    await once(ws, 'open');
    return { ws, messages };
  };
  try {
    const [a, b, c] = await Promise.all([open(), open(), open()]);
    const until = async (ok: () => boolean) => {
      while (!ok()) await new Promise((r) => setTimeout(r, 10));
    };
    await until(() => [a, b, c].every((s) => s.messages.length === 1));
    const first: Snapshot = JSON.parse(a.messages[0]);
    assert.ok(Array.isArray(first.sessions) && 'uiEntry' in first);
    c.ws.close();
    await once(c.ws, 'close');
    notify();
    await until(() => a.messages.length === 2 && b.messages.length === 2);
    assert.equal(a.messages[1], b.messages[1]);
    assert.equal(c.messages.length, 1);
    a.ws.close();
    b.ws.close();
  } finally {
    server.close();
  }
});
