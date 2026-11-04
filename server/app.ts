import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { upgradeWebSocket, type WebSocketServerLike } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { WSContext } from 'hono/ws';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { handleAdvisorMcp, retryAdvice, stopAdvice } from './advisor.ts';
import { ARTIFACT_CSP, artifactFile } from './artifacts.ts';
import { drift } from './claudeFormat.ts';
import { listCommands } from './commands.ts';
import { actionBodies, bodies, isAction, onDecision, type ActionHandlers, type ActionName, type Responses, type RouteInput } from './contract.ts';
import { HOST, PORT, ROOT, UPLOADS_DIR, WEB_DIST } from './config.ts';
import { repos, roots, schedules, sessions, uxEvents } from './db.ts';
import { openDecision, Refusal } from './decision.ts';
import { elaborate } from './explain.ts';
import { respond } from './findings.ts';
import { folderDiff } from './folderTasks.ts';
import { fullDiff, listBranches, repoRoot, upstreamOf } from './git.ts';
import { handleMcp } from './mcp.ts';
import { clearing, deleteWorktree, deleteWorktreeLoss, hideRepo, removeWorktreeAndSessions } from './removal.ts';
import { nextRun, parseSchedule, repeats } from './schedule.ts';
import * as S from './sessions.ts';
import { modelChoices, plan, startFolderTask, startRepoTask } from './tasks.ts';
import { UPLOAD_DIR_NAME, UPLOAD_IMAGE_NAME, UPLOAD_IMAGE_TYPES } from './uploadPaths.ts';
import { checkUploads, MAX_BYTES, saveUpload } from './uploads.ts';
import type { Usage } from './usage.ts';
import { boardAnswer, boardTracker, cleanBatch, cleanEvent, type Data } from './uxlog.ts';
import { folders, notify, onChange, refreshWorkspace, repoView, snapshot, taskFolderOf, workspace } from './workspace.ts';

const run = promisify(execFile);

export const UI_INDEX = join(WEB_DIST, 'index.html');

// What serve() upgrades sockets with. ws types `options.noServer` as `boolean | undefined`, which hono's own type refuses
// under exactOptionalPropertyTypes.
export const socketServer = () => new WebSocketServer({ noServer: true }) as WebSocketServerLike;

// A request the page or a hook got wrong, as opposed to a fault here.
export class Invalid extends Error {}

const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const allowedOrigins = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);

const JSON_TYPE = /^application\/json\s*(;|$)/i;

async function input<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  const text = await c.req.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Invalid('the body is not JSON');
    }
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Invalid(z.prettifyError(parsed.error));
  return parsed.data;
}

const knownRepo = (id: number) => {
  const repo = repoView(id);
  if (!repo) throw new Invalid('unknown repo');
  return repo;
};

const repoOfWorktree = (worktree: string) => {
  const repo = workspace().find((r) => r.worktrees.some((w) => w.path === worktree));
  if (!repo) throw new Invalid('unknown worktree');
  return repo;
};

const diffOf = (worktree: string, opts: { paths?: string[] } = {}) =>
  taskFolderOf(worktree) ? folderDiff(worktree, opts)
    : fullDiff(worktree, repoOfWorktree(worktree).base, opts);

const withClearing = (all: ReturnType<typeof snapshot>) => ({ ...all, sessions: all.sessions.map((s) => ({ ...s, ...clearing.of(s.id) })) });

const stateWith = (usage: Usage | null) =>
  ({ ...withClearing(snapshot()), schedules: schedules.all(), usage, pause: S.pauseState(), drift: drift(), pitwall: ROOT });

// What /api/state answers, and /ws/events sends on every change.
export type State = ReturnType<typeof stateWith>;
export type Snapshot = State & { uiEntry: string | null };

const actions: ActionHandlers<string> = {
  answer: async (id, b) => { await S.answer(id, b); },
  dismiss: (id, b) => { S.dismiss(id, b.key ?? null); },
  rename: async (id, b) => { await S.rename(id, b.title); },
  'answer-menu': async (id, b) => { await S.answerMenu(id, b); },
  'accept-advice': async (id, b) => { await S.acceptAdvice(id, b.adviceAt); },
  'retry-advice': (id) => { retryAdvice(id); },
  'stop-advice': (id) => { stopAdvice(id); },
  elaborate: (id) => { elaborate(id); },
  focus: async (id) => { await S.focus(id); },
  finder: async (id) => { await S.openIn(id, 'finder'); },
  vscode: async (id) => { await S.openIn(id, 'vscode'); },
  quit: async (id) => { await S.quit(id); },
  forget: async (id) => { await S.forget(id); },
  archive: (id, b) => { S.archive(id, b.archived ?? true); },
  priority: (id, b) => { S.setPriority(id, b.priority); },
  resolve: (id, b) => { S.resolve(id, b.state); },
  'delete-worktree': async (id, b) => { await deleteWorktree(id, { discard: b.discard === true }); },
  'dismiss-clear-error': (id) => { clearing.dismiss(id); },
  finding: async (id, b) => ({ id: await respond(id, b) }),
  park: (id, b) => { S.park(id, b); },
  'edit-park': (id, b) => { S.editPark(id, b); },
  unpark: (id, b) => { S.unpark(id, b.draft); },
  'ask-aside': (id, b) => ({ id: S.askAside(id, b) }),
  'stop-aside': (id, b) => { S.stopAside(id, b.aside); },
  'close-aside': async (id, b) => { await S.closeAside(id, b.aside); },
};

const answering: ReadonlySet<ActionName> = new Set(['answer', 'answer-menu', 'accept-advice', 'dismiss']);

const read = <K extends keyof typeof bodies>(c: Context, route: K) => input(c, bodies[route]) as Promise<RouteInput<K>>;

export interface AppDeps {
  usage: { current(): Usage | null };
  // The UI build's entry the polls settled on, and a read of it now.
  ui: { settled(): string | null; fresh(): Promise<string | null> };
}

export function createApp({ usage, ui }: AppDeps) {
  const app = new Hono();
  const state = () => stateWith(usage.current());

  // Loopback alone does not stop a web page from reaching us; reject foreign hosts (DNS rebinding) and foreign
  // origins (cross-site requests).
  app.use(async (c, next) => {
    const host = c.req.header('host') ?? '';
    const origin = c.req.header('origin');
    if (!allowedHosts.has(host)) return c.text('forbidden host', 403);
    if (origin && !allowedOrigins.has(origin)) return c.text('forbidden origin', 403);
    return next();
  });

  // A body a cross-site form or a no-cors fetch could send without a preflight is refused, should an origin get past.
  app.use('/api/*', async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
    const upload = c.req.path === '/api/uploads';
    if (upload ? !c.req.header('x-filename') : !JSON_TYPE.test(c.req.header('content-type') ?? '')) {
      return c.json({ error: upload ? 'an upload names its file in x-filename' : 'send the body as application/json' }, 415);
    }
    await next();
  });

  // A refusal is the page acting on a decision that moved on, not a fault. Node's own errors carry a code too.
  app.onError((err, c) => {
    const refused = err instanceof Refusal;
    const invalid = refused || err instanceof Invalid;
    if (!invalid) console.error(c.req.method, c.req.path, err);
    return c.json({ error: err instanceof Error ? err.message : String(err), ...(refused && { code: err.code }) }, invalid ? 400 : 500);
  });

  app.get('/api/state', (c) => c.json(state() satisfies Responses['GET /api/state']));

  app.all('/mcp', (c) => handleMcp(c.req.raw));
  app.all('/mcp/advisor/:token', (c) => handleAdvisorMcp(c.req.raw, c.req.param('token')));

  // Repositories and the folders scanned for them.

  app.post('/api/pick-folder', async (c) => {
    const { stdout } = await run('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a repository, or a folder to scan for repositories")']);
    return c.json({ path: stdout.trim().replace(/\/$/, '') } satisfies Responses['POST /api/pick-folder']);
  });

  app.post('/api/open', async (c) => {
    const url = URL.parse((await read(c, 'POST /api/open')).url);
    if (!url || !['http:', 'https:'].includes(url.protocol)) return c.text('not a web link', 400);
    await run('/usr/bin/open', [url.href]);
    return c.body(null, 204);
  });

  app.post('/api/repos', async (c) => {
    const path = (await read(c, 'POST /api/repos')).path.trim().replace(/(.)\/$/, '$1');
    // A dotfiles repo in ~ would otherwise swallow every folder picked under it.
    const found = await repoRoot(path).catch(() => null);
    const root = found === homedir() && path !== found ? null : found;
    if (root) repos.add(root);
    else if ((await stat(path).catch(() => null))?.isDirectory()) roots.add(path);
    else throw new Invalid(`not a folder: ${path}`);
    await refreshWorkspace({ scan: !root });
    return c.json({ scanned: !root } satisfies Responses['POST /api/repos']);
  });

  app.delete('/api/roots', async (c) => {
    roots.remove((await read(c, 'DELETE /api/roots')).path);
    await refreshWorkspace();
    return c.body(null, 204);
  });

  app.post('/api/rescan', async (c) => {
    await refreshWorkspace({ scan: true });
    return c.body(null, 204);
  });

  app.patch('/api/repos/:id', async (c) => {
    repos.update(Number(c.req.param('id')), await read(c, 'PATCH /api/repos/:id'));
    await refreshWorkspace();
    return c.body(null, 204);
  });

  app.delete('/api/repos/:id', async (c) => {
    await hideRepo(Number(c.req.param('id')));
    await refreshWorkspace();
    return c.body(null, 204);
  });

  app.get('/api/repos/:id/branches', async (c) => {
    const repo = knownRepo(Number(c.req.param('id')));
    const checkedOut = new Map(repo.worktrees.flatMap((w) => (w.branch ? [[w.branch, w.path]] : [])));
    return c.json((await listBranches(repo.path)).map((b) => ({ ...b, worktree: checkedOut.get(b.name) ?? null })) satisfies Responses['GET /api/repos/:id/branches']);
  });

  app.get('/api/repos/:id/models', async (c) => c.json((await modelChoices(knownRepo(Number(c.req.param('id'))).path)) satisfies Responses['GET /api/repos/:id/models']));

  app.get('/api/folders/models', async (c) => {
    const folder = folders().find((f) => f.path === c.req.query('path'));
    if (!folder) throw new Invalid('unknown folder');
    return c.json((await modelChoices(folder.path)) satisfies Responses['GET /api/folders/models']);
  });

  // Tasks: starting them, now or on a schedule, and removing their worktrees.

  app.post('/api/folder-tasks', async (c) => c.json((await startFolderTask(await read(c, 'POST /api/folder-tasks'))) satisfies Responses['POST /api/folder-tasks']));

  app.post('/api/worktrees', async (c) => c.json((await startRepoTask(await read(c, 'POST /api/worktrees'))) satisfies Responses['POST /api/worktrees']));

  app.delete('/api/worktrees', async (c) => {
    const body = await read(c, 'DELETE /api/worktrees');
    await removeWorktreeAndSessions(knownRepo(body.repoId), body.path, { force: !!body.force, deleteBranch: !!body.deleteBranch });
    return c.body(null, 204);
  });

  app.post('/api/schedules', async (c) => {
    const now = Date.now();
    const { name, task, when: at } = parseSchedule(await read(c, 'POST /api/schedules'), now);
    task.files = await checkUploads(task.files);
    const schedule = { id: randomUUID(), name, task, when: at, next: nextRun(at, now), paused: false, last: null, createdAt: now };
    schedules.save(schedule);
    notify();
    return c.json(schedule satisfies Responses['POST /api/schedules']);
  });

  app.patch('/api/schedules/:id', async (c) => {
    const s = schedules.all().find((x) => x.id === c.req.param('id'));
    if (!s) throw new Invalid('unknown schedule');
    const { paused } = await read(c, 'PATCH /api/schedules/:id');
    // A repeating schedule picks up again at its next time after now, not at the runs it missed while paused.
    const next = !paused && repeats(s.when) ? nextRun(s.when, Date.now()) : s.next;
    schedules.save({ ...s, paused, next });
    notify();
    return c.body(null, 204);
  });

  app.delete('/api/schedules/:id', (c) => {
    schedules.remove(c.req.param('id'));
    notify();
    return c.body(null, 204);
  });

  app.post('/api/schedules/:id/run', async (c) => c.json((await plan.runNow(c.req.param('id'))) satisfies Responses['POST /api/schedules/:id/run']));

  // Sessions: starting one in a worktree, and what the page does to one.

  app.post('/api/sessions', async (c) => {
    const body = await read(c, 'POST /api/sessions');
    const repo = knownRepo(body.repoId);
    if (!repo.worktrees.some((w) => w.path === body.worktree)) throw new Invalid('unknown worktree');
    const start = { repoId: repo.id, worktree: body.worktree };
    const id = body.continueId ? await S.continueConversation({ ...start, continueId: body.continueId }) : await S.startClaude(start);
    await refreshWorkspace();
    return c.json({ id } satisfies Responses['POST /api/sessions']);
  });

  app.post('/api/shell', async (c) => {
    await S.openShell((await read(c, 'POST /api/shell')).worktree);
    return c.body(null, 204);
  });

  app.get('/api/sessions/:id/artifacts/:artifact', async (c) => {
    const html = await readFile(artifactFile(c.req.param('id'), c.req.param('artifact')), 'utf8').catch(() => null);
    if (html === null) return c.text('artifact not found', 404);
    c.header('content-security-policy', ARTIFACT_CSP);
    return c.html(html);
  });

  app.get('/api/sessions/:id/conversation', async (c) => c.json((await S.conversation(c.req.param('id'))) satisfies Responses['GET /api/sessions/:id/conversation']));
  app.get('/api/sessions/:id/conversation/:conversation/:entry/:n', async (c) => {
    const image = await S.conversationImage(c.req.param('id'), c.req.param('conversation'), c.req.param('entry'), Number(c.req.param('n')));
    if (!image) return c.text('image not found', 404);
    return c.body(new Uint8Array(image.data), 200, { 'content-type': image.type, 'cache-control': 'private, max-age=31536000, immutable' });
  });
  app.get('/api/sessions/:id/delete-worktree', async (c) => c.json((await deleteWorktreeLoss(c.req.param('id'))) satisfies Responses['GET /api/sessions/:id/delete-worktree']));

  function recordServer(name: string, data: Data) {
    const event = cleanEvent(name, data, Date.now());
    if (event) uxEvents.add('server', 'server', [event]);
  }

  const tracker = boardTracker(recordServer);
  tracker.observe(sessions.all());
  onChange(() => tracker.observe(sessions.all()));

  // A board answer that left its decision open, such as a slash command or a send that failed, answered nothing.
  function settleAnswer(id: string, answered: Data) {
    const s = sessions.get(id);
    const still = !!s && openDecision(s)?.key === answered.decision;
    if (still) tracker.unmark(answered.decision as string);
    else recordServer('decision-answer', answered);
  }

  app.post('/api/sessions/:id/:action', async (c) => {
    const id = c.req.param('id');
    const name = c.req.param('action');
    if (!isAction(name)) return c.text('unknown action', 404);
    const body: Data = await input(c, actionBodies[name]);
    if (onDecision.has(name)) S.expectDecision(id, body.key as string | null | undefined);
    const before = sessions.get(id);
    const answered = before && answering.has(name) ? boardAnswer(before, name, body) : null;
    if (answered) tracker.answeredOnBoard(answered.decision as string);
    try {
      const out: unknown = await actions[name](id, body as never);
      return out === undefined ? c.body(null, 204) : c.json(out);
    } finally {
      if (answered) settleAnswer(id, answered);
    }
  });

  // Restarts and Pause.

  app.post('/api/restart/resume', async (c) => c.json((await S.resumeInterrupted((await read(c, 'POST /api/restart/resume')).paused === true)) satisfies Responses['POST /api/restart/resume']));

  app.post('/api/restart/dismiss', async (c) => {
    S.dismissInterrupted((await read(c, 'POST /api/restart/dismiss')).paused === true ? 'both' : 'restart');
    return c.body(null, 204);
  });

  app.post('/api/pause', (c) => c.json(S.pause() satisfies Responses['POST /api/pause']));

  app.post('/api/pause/now', async (c) => c.json((await S.hurryPause()) satisfies Responses['POST /api/pause/now']));

  app.post('/api/pause/resume', async (c) => c.json((await S.resumePaused((await read(c, 'POST /api/pause/resume')).id)) satisfies Responses['POST /api/pause/resume']));

  app.post('/api/pause/dismiss', (c) => {
    S.dismissInterrupted('pause');
    return c.body(null, 204);
  });

  // Attachments.

  app.get('/api/uploads/:dir/:name', async (c) => {
    const { dir, name } = c.req.param();
    const ok = UPLOAD_DIR_NAME.test(dir) && UPLOAD_IMAGE_NAME.test(name);
    const data = ok ? await readFile(join(UPLOADS_DIR, dir, name)).catch(() => null) : null;
    if (!data) return c.text('picture not found', 404);
    return c.body(new Uint8Array(data), 200, { 'content-type': UPLOAD_IMAGE_TYPES[name.split('.').at(-1)!.toLowerCase()], 'cache-control': 'private, max-age=31536000, immutable' });
  });

  const tooBig = bodyLimit({ maxSize: MAX_BYTES, onError: (c) => c.json({ error: `files over ${MAX_BYTES / 1024 / 1024} MB are not accepted` }, 413) });

  app.post('/api/uploads', tooBig, async (c) => {
    const path = await saveUpload(decodeURIComponent(c.req.header('x-filename')!), await c.req.arrayBuffer());
    return c.json({ path });
  });

  // What the page and Claude's hooks report.

  app.post('/api/ux', async (c) => {
    const batch = cleanBatch(await read(c, 'POST /api/ux'));
    if (!batch) return c.text('bad batch', 400);
    if (batch.events.length) uxEvents.add('page', batch.page, batch.events);
    return c.body(null, 204);
  });

  // Claude Code's hook input, which grows fields of its own over time.
  app.post('/api/hooks/ask-user-question', async (c) => {
    S.menuOpened(await read(c, 'POST /api/hooks/ask-user-question'));
    return c.body(null, 204);
  });

  app.post('/api/hooks/event', async (c) => {
    await S.hookEvent(await read(c, 'POST /api/hooks/event'));
    return c.body(null, 204);
  });

  // Worktrees' commands and changes.

  app.get('/api/commands', async (c) => c.json((await listCommands(c.req.query('worktree') ?? '')) satisfies Responses['GET /api/commands']));

  app.get('/api/diff/file', async (c) => {
    const worktree = c.req.query('worktree') ?? '';
    const paths = c.req.queries('path') ?? [];
    if (!paths.length || paths.some((p) => isAbsolute(p) || p.split('/').includes('..'))) throw new Invalid('bad path');
    return c.json((await diffOf(worktree, { paths })) satisfies Responses['GET /api/diff/file']);
  });

  app.get('/api/upstream', async (c) => {
    const worktree = c.req.query('worktree') ?? '';
    return c.json((taskFolderOf(worktree) ? null : await upstreamOf(worktree, repoOfWorktree(worktree).base)) satisfies Responses['GET /api/upstream']);
  });

  app.get('/api/diff', async (c) => {
    const worktree = c.req.query('worktree') ?? '';
    const diff = await diffOf(worktree);
    for (const s of sessions.all().filter((s) => s.worktree === worktree)) sessions.update(s.id, { diffstat: diff.stat });
    notify();
    return c.json(diff satisfies Responses['GET /api/diff']);
  });

  // Every snapshot names the UI build, so a page from an older one reloads, also after a `pnpm build` alone.
  const message = (): string => JSON.stringify({ ...state(), uiEntry: ui.settled() } satisfies Snapshot);
  const sockets = new Set<WSContext>();
  onChange(() => {
    if (!sockets.size) return;
    const m = message();
    for (const ws of sockets) ws.send(m);
  });

  app.get('/ws/events', upgradeWebSocket(() => {
    let closed = false;
    let socket: WSContext | undefined;
    return {
      // The page may run a build the polls have not taken yet: a read now that finds another entry empties settled(),
      // so it is told none rather than the older one. The read itself is never named, as the build may still be writing.
      async onOpen(_evt, ws) {
        await ui.fresh();
        if (closed) return;
        socket = ws;
        sockets.add(ws);
        ws.send(message());
      },
      onClose() {
        closed = true;
        if (socket) sockets.delete(socket);
      },
    };
  }));

  app.use('/*', serveStatic({ root: WEB_DIST }));
  app.get('*', async (c) => {
    const html = await readFile(UI_INDEX, 'utf8').catch(() => null);
    return html ? c.html(html) : c.text('UI not built: run `pnpm build`', 503);
  });

  return app;
}
