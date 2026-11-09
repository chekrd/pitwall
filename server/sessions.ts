import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { adviseOpen } from './advisor.ts';
import { answering, Called } from './answering.ts';
import { listCommands } from './commands.ts';
import { conversationMeta, describeTool, exchanges, guessedTranscriptFile, hookedConversation, liveConversations, parseMenu, promptImage, signal, transcriptFile, type ConversationLog, type LiveProcess } from './conversations.ts';
import { report } from './claudeFormat.ts';
import { SESSIONS_DIR } from './config.ts';
import { checkDecision } from './decision.ts';
import { handOver, taskOf } from './handover.ts';
import { sessions, type Parent, type Session, type Starting } from './db.ts';
import { quote } from './env.ts';
import { isClean, listBranches, switchBranch } from './git.ts';
import { CLAUDE, headless } from './headless.ts';
import { asking } from './asides.ts';
import * as ghostty from './ghostty.ts';
import * as terminal from './terminal.ts';
import { clip, scheduleRerank, trackDecisions } from './priority.ts';
import { notify, type RepoView } from './workspace.ts';
import { folderArgs } from './folderTasks.ts';
import { sync } from './ingest.ts';
import { pauser, RESUME_PROMPT } from './pause.ts';
import { archivePatch } from './restart.ts';
import { addParked, editParked, removeParked, turnEnds } from './parked.ts';
import type { Scheduled } from './schedule.ts';
import { checkUploads } from './uploads.ts';

const run = promisify(execFile);

// A launch script keeps the prompt out of the user's shell, whose quoting rules may not be POSIX.
async function launch(id: string, cwd: string, args: string[], setup?: string | null) {
  const dir = join(SESSIONS_DIR, id);
  await mkdir(dir, { recursive: true });
  const script = join(dir, 'start.sh');
  const lines = ['#!/bin/sh', `cd ${quote(cwd)} || exit`, setup ?? '', `exec ${[CLAUDE, ...folderArgs(cwd), ...args].map(quote).join(' ')}`].filter(Boolean);
  await writeFile(script, `${lines.join('\n')}\n`);
  await terminal.start(id, cwd, `/bin/sh ${quote(script)}`);
}

interface NewClaude {
  repoId: number | null;
  worktree: string;
  prompt?: string | undefined;
  title?: string;
  setup?: string | null | undefined;
  parent?: Parent;
  model?: string | undefined;
  effort?: string | undefined;
  running?: { model: string | null; effort: string | null };
  scheduled?: Scheduled | undefined;
}

// With a prompt, Claude starts on it at once; until it registers, idle would show a finished turn that never was.
const firstStatus = (opts: NewClaude) => (opts.prompt ? 'working' : 'idle');

function addTask(opts: NewClaude, status: Session['status']) {
  const id = randomUUID();
  sessions.insert({
    id, repoId: opts.repoId, worktree: opts.worktree, cwd: opts.worktree, pid: null, tty: null,
    title: opts.title || null, firstPrompt: opts.prompt || null, status,
  });
  sessions.update(id, { parent: opts.parent ?? null, scheduled: opts.scheduled ?? null, ...opts.running });
  return id;
}

function launchClaude(id: string, opts: NewClaude) {
  const chosen = [...(opts.model ? ['--model', opts.model] : []), ...(opts.effort ? ['--effort', opts.effort] : [])];
  return launch(id, opts.worktree, [...chosen, '--session-id', id, ...(opts.prompt ? ['--', opts.prompt] : [])], opts.setup);
}

export async function startClaude(opts: NewClaude) {
  const id = addTask(opts, firstStatus(opts));
  try {
    await launchClaude(id, opts);
  } catch (err) {
    sessions.remove(id);
    throw err;
  }
  notify();
  return id;
}

// The task is on the board at once, working on its first step; Claude starts when `prepare` is done. `ready` settles
// then, and it is up to the caller what a failure comes to.
export function startAfter(opts: NewClaude, request: Starting['request'], step: string, prepare: () => Promise<unknown>) {
  const id = addTask(opts, 'working');
  sessions.update(id, { starting: { request, error: null }, activity: { step, since: Date.now() } });
  notify();
  const ready = prepare().then(async () => {
    if (!sessions.get(id)) return;
    await launchClaude(id, opts);
    sessions.update(id, { starting: null, activity: null, status: firstStatus(opts) });
    notify();
  });
  return { id, ready };
}

// Exited, so that nothing takes it for a Claude to look after; it stays on the board with why until it is removed.
export function startFailed(id: string, error: string) {
  const s = sessions.get(id);
  if (!s?.starting) return;
  sessions.update(id, { status: 'exited', activity: null, starting: { ...s.starting, error } });
  notify();
}

// What was being prepared when Pitwall stopped never finished.
export function settleStarting() {
  for (const s of sessions.all()) {
    if (s.starting && !s.starting.error) startFailed(s.id, 'Pitwall restarted before the worktree was ready');
  }
}

// `continueId` names a conversation; a task that ran it, now or before a /clear, picks it up again.
export async function continueConversation(opts: { repoId: number | null; worktree: string; continueId: string; cwd?: string; prompt?: string }) {
  const id = opts.continueId;
  const cwd = opts.cwd ?? opts.worktree;
  const existing = taskOf(sessions.all(), id);
  if (existing && existing.status !== 'exited') {
    await focus(existing.id);
    return existing.id;
  }
  if ((await liveConversations()).has(id)) throw new Error('this conversation is open in a terminal that is not a Ghostty tab');
  const meta = await conversationMeta(existing?.cwd ?? cwd, id);
  // Claude writes no transcript until the first prompt, so a task never prompted starts again as it first did.
  if (!meta && existing && existing.conversation === id && !existing.firstPrompt && !existing.lastPrompt && !existing.history.length) {
    sessions.update(existing.id, { pid: null, tty: null, status: 'idle', archived: false });
    await launch(existing.id, existing.cwd, ['--session-id', id]);
    notify();
    return existing.id;
  }
  if (!meta) throw new Error('conversation not found in this worktree');
  if (existing) {
    sessions.update(existing.id, {
      ...(existing.conversation !== id && handOver(existing, id, Date.now())),
      pid: null, tty: null, status: opts.prompt ? 'working' : 'idle', archived: false,
    });
    await launch(existing.id, existing.cwd, ['--resume', id, ...(opts.prompt ? ['--', opts.prompt] : [])]);
    notify();
    return existing.id;
  }
  sessions.insert({
    id, repoId: opts.repoId, worktree: opts.worktree, cwd, pid: null, tty: null,
    title: meta.title, firstPrompt: meta.firstPrompt, status: 'idle',
  });
  await launch(id, cwd, ['--resume', id]);
  notify();
  return id;
}

// After a restart of the Mac, every task it cut short comes back in a hidden terminal, as Continue would bring it,
// and with `paused` every paused task carries on as its own Resume has it.
export async function resumeInterrupted(paused = false) {
  const failed: { id: string; error: string }[] = [];
  const tasks = sessions.all().filter((s) => s.status === 'exited' && s.interrupted && s.interrupted.cause !== 'pause' && !s.archived);
  for (const s of tasks) {
    try {
      await continueConversation({ repoId: s.repoId, worktree: s.worktree, cwd: s.cwd, continueId: s.conversation });
    } catch (err) {
      failed.push({ id: s.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!paused) return { resumed: tasks.length - failed.length, failed };
  const more = await resumePaused();
  return { resumed: tasks.length - failed.length + more.resumed, failed: [...failed, ...more.failed] };
}

// Ended ones stay ended as any other, and resumed ones wait for you as any other.
export function dismissInterrupted(which: 'restart' | 'pause' | 'both') {
  if (which !== 'restart') pausing.cancel();
  for (const s of sessions.all()) {
    if (s.interrupted && (which === 'both' || (s.interrupted.cause === 'pause') === (which === 'pause'))) sessions.update(s.id, { interrupted: null });
  }
  notify();
}

// A task with no Claude yet has nothing to stop; once it starts, the pause takes it up as any other.
const withClaude = () => sessions.all().filter((s) => !s.starting);

export function pause() {
  const result = pausing.start(withClaude());
  notify();
  return result;
}

export async function hurryPause() {
  const result = await pausing.hurry(withClaude());
  notify();
  return result;
}

export const pauseState = () => ({ stopping: pausing.stopping(), finishing: pausing.finishing() });

export function pauseStep() {
  if (pausing.step(withClaude())) notify();
}

// Each paused task is asked to carry on; one whose Claude ended meanwhile, by a restart too, comes back on that prompt.
export async function resumePaused(only?: string) {
  const failed: { id: string; error: string }[] = [];
  const tasks = sessions.all().filter((s) => s.interrupted?.cause === 'pause' && s.status !== 'working' && (!only || s.id === only));
  for (const s of tasks) {
    try {
      if (s.status === 'exited') await continueConversation({ repoId: s.repoId, worktree: s.worktree, cwd: s.cwd, continueId: s.conversation, prompt: RESUME_PROMPT });
      else await answers.type(s.id, RESUME_PROMPT);
    } catch (err) {
      failed.push({ id: s.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { resumed: tasks.length - failed.length, failed };
}

export async function openShell(worktree: string) {
  if (!existsSync(worktree)) throw new Error(`${worktree} no longer exists`);
  await ghostty.newTab(worktree, '');
}

export async function focus(id: string) {
  await answers.settled(id);
  const s = must(id);
  if (s.status === 'exited') await continueConversation({ repoId: s.repoId, worktree: s.worktree, cwd: s.cwd, continueId: s.conversation });
  else await terminal.show(s.tty, s.id, s.cwd);
}

async function isCommand(s: Session, text: string) {
  if (text.startsWith('!')) return true;
  const name = text.match(/^\/(\S+)/)?.[1];
  return !!name && (await listCommands(s.worktree)).some((c) => c.name === name);
}

export function expectDecision(id: string, seen: string | null | undefined) {
  checkDecision(must(id), seen);
}

function decided() {
  trackDecisions();
  adviseOpen();
  notify();
}

const answers = answering({ store: sessions, send: terminal.send, keys: terminal.keys, notify, decided, isCommand, checkUploads });

export const { answerMenu, acceptAdvice, dismiss } = answers;

// A send from the board may carry drafts, which leave the task once it went out.
export async function answer(id: string, reply: Parameters<typeof answers.answer>[1] & { drafts?: unknown }) {
  await answers.answer(id, reply);
  if (Array.isArray(reply.drafts) && reply.drafts.length) {
    sessions.update(id, { parked: removeParked(must(id).parked, reply.drafts) });
    notify();
  }
}

export function park(id: string, body: { text: string; auto?: boolean | undefined }) {
  sessions.update(id, { parked: addParked(must(id).parked, body) });
  notify();
}

export function editPark(id: string, body: { draft: string; text?: string | undefined; auto?: boolean | undefined }) {
  sessions.update(id, { parked: editParked(must(id).parked, body) });
  notify();
}

export function unpark(id: string, draft: unknown) {
  sessions.update(id, { parked: removeParked(must(id).parked, [draft]) });
  notify();
}

const ASIDE_TOOLS = 'Read,Grep,Glob,WebFetch,WebSearch';
const ASIDE_MS = 15 * 60_000;

// A fork reads the task's files and the web on the task's own model, without its MCP servers or hooks, which could
// act on the task. A first question that fails after forking leaves no fork behind.
const asides = asking({
  get: sessions.get,
  save: (id, list) => {
    sessions.update(id, { asides: list });
    notify();
  },
  run: async (s, prompt, fork, signal, activity) => {
    let started: string | null = null;
    try {
      const out = await headless(prompt, {
        cwd: s.cwd,
        timeoutMs: ASIDE_MS,
        signal,
        urgent: true,
        persist: true,
        onEvent: (e) => {
          if (e.type === 'system' && typeof e.session_id === 'string') started = e.session_id;
          const tool = e.type === 'assistant' && e.message?.content?.findLast?.((b: any) => b.type === 'tool_use');
          if (tool) activity(clip(describeTool(tool).replaceAll(s.worktree, '.'), 140));
        },
        args: [
          ...folderArgs(s.cwd), '--resume', fork ?? s.conversation, ...(fork ? [] : ['--fork-session']),
          ...(s.model ? ['--model', s.model] : []), ...(s.effort ? ['--effort', s.effort] : []),
          '--settings', JSON.stringify({ disableAllHooks: true }), '--strict-mcp-config', '--tools', ASIDE_TOOLS, '--allowedTools', ASIDE_TOOLS,
        ],
      });
      const answer = String(out.result ?? '').trim();
      if (out.is_error || !answer) throw new Error(answer || 'the fork gave no answer');
      return { fork: String(out.session_id ?? started), answer };
    } catch (err) {
      if (!fork && started) await discardFork(s, started).catch(() => {});
      throw err;
    }
  },
  discard: (s, fork) => discardFork(s, fork),
});

async function discardFork(s: Session, fork: string) {
  const file = await guessedTranscriptFile(s.cwd, fork);
  await rm(file, { force: true });
  await rm(file.replace(/\.jsonl$/, ''), { recursive: true, force: true });
}

export const askAside = (id: string, body: { text: string; aside?: string | null | undefined }) => asides.ask(id, body);
export const stopAside = (id: string, aside: unknown) => asides.stop(id, aside);
export const closeAside = (id: string, aside: unknown) => asides.close(id, aside);
export const settleAsides = () => asides.settle(sessions.all());
export const dropAsides = (gone: Session[]) => Promise.all(gone.map((s) => asides.drop(s)));

const ends = turnEnds();
const autoSending = new Set<string>();

export function sendDueDrafts() {
  for (const due of ends.observe(sessions.all(), pausing.stopping())) {
    if (autoSending.has(due.id)) continue;
    autoSending.add(due.id);
    // A pause that began while they waited for their turn keeps them.
    const wanted = () => !pausing.stopping().includes(due.id) && !sessions.get(due.id)?.interrupted;
    void answers.answer(due.id, { key: null, text: due.text }, false, wanted)
      .then(() => {
        sessions.update(due.id, { parked: removeParked(must(due.id).parked, due.ids) });
        notify();
      })
      .catch((err) => {
        if (!(err instanceof Called)) console.warn('drafts not sent at the end of the turn', due.id, err);
      })
      .finally(() => autoSending.delete(due.id));
  }
}

// Said in a notification, as the board may be out of sight.
function notifyPaused() {
  const script = 'display notification "No Claude is at work: safe to close the laptop or restart." with title "Pitwall" subtitle "Paused"';
  run('/usr/bin/osascript', ['-e', script]).catch((err) => console.warn('pause notification failed', err));
}

const pausing = pauser({
  escape: (id) => answers.press(id, [{ key: 'escape' }]),
  type: answers.type,
  mark: (id, interrupted) => sessions.update(id, { interrupted }),
  safe: notifyPaused,
});

// A running Claude keeps its name in memory and writes it back to the transcript, so a live
// session is renamed with its own /rename (it runs even mid-turn); an ended one in the file.
export async function rename(id: string, title: string) {
  const s = must(id);
  const name = title.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw new Error('the name is empty');
  if (s.status === 'exited') {
    const file = await transcriptFile(s.cwd, s.conversation);
    if (await stat(file).catch(() => null)) await appendFile(file, `${JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: s.id })}\n`);
  } else {
    await answers.type(id, `/rename ${name}`);
  }
  sessions.update(id, { title: name });
  notify();
}

// The task's prompts and Claude's replies, oldest first, through every conversation it had before a /clear too.
export async function conversation(id: string): Promise<ConversationLog[]> {
  const s = must(id);
  return Promise.all([...s.history.map((h) => h.id), s.conversation].map(async (c) => ({ id: c, exchanges: await exchanges(await transcriptFile(s.cwd, c)) })));
}

export async function conversationImage(id: string, conversation: string, entry: string, n: number) {
  const s = must(id);
  if (![...s.history.map((h) => h.id), s.conversation].includes(conversation) || !/^[\w-]+$/.test(entry)) return null;
  return promptImage(await transcriptFile(s.cwd, conversation), entry, n);
}

// Posted by the PreToolUse hook that `pnpm claude:connect` installs, just before the dialog opens.
export function menuOpened(hook: { session_id?: string | undefined; tool_use_id?: string | undefined; tool_input?: unknown }) {
  const menu = parseMenu(hook.tool_use_id ?? '', hook.tool_input);
  const s = hook.session_id ? sessions.byConversation(hook.session_id) : undefined;
  if (!menu || !s) return;
  sessions.update(s.id, { menu });
  notify();
}

// Posted by the SessionStart, UserPromptSubmit, Stop and Notification hooks that `pnpm claude:connect` installs. Each
// one syncs at once; the poll stays to reconcile what a hook missed, such as a Claude that crashed.
export async function hookEvent(hook: { session_id?: unknown; transcript_path?: unknown; cwd?: unknown; hook_event_name?: unknown; source?: unknown }) {
  const id = typeof hook.session_id === 'string' ? hook.session_id : null;
  if (!id) return;
  const transcript = typeof hook.transcript_path === 'string' && hook.transcript_path ? hook.transcript_path : null;
  const start = hook.hook_event_name === 'SessionStart';
  hookedConversation(id, { transcript, source: start && typeof hook.source === 'string' ? hook.source : null });
  // Only at startup is the hook's cwd the folder the transcript is filed under: SessionStart fires again on /clear and
  // compaction, after Claude may have cd'd away. Before the folder exists a long path's hashed name cannot be found.
  if (start && hook.source === 'startup' && transcript && typeof hook.cwd === 'string' && existsSync(dirname(transcript)) && (await guessedTranscriptFile(hook.cwd, id)) !== transcript) {
    report(['transcripts are no longer where Pitwall looks for them without a hook'], null);
  }
  await sync();
}

export async function openIn(id: string, app: 'finder' | 'vscode') {
  const s = must(id);
  if (!existsSync(s.worktree)) throw new Error(`${s.worktree} no longer exists`);
  await run('/usr/bin/open', [...(app === 'vscode' ? ['-b', 'com.microsoft.VSCode'] : []), s.worktree]);
}

// The task's Claude, while it runs: macOS reuses pids, so the stored one counts only while a live Claude, checked by
// its start time, has it in the task's conversation or in one no other task has, as after a /clear not yet seen.
export function claudeOf(s: Session, live: Map<string, LiveProcess>) {
  if (!s.pid) return null;
  for (const [conversation, p] of live) {
    if (p.pid === s.pid && (conversation === s.conversation || !sessions.byConversation(conversation))) return s.pid;
  }
  return null;
}

// Settles without failing once the task is known.
export function quit(id: string) {
  const s = must(id);
  if (!s.pid) return Promise.resolve();
  return liveConversations().then((live) => {
    const pid = claudeOf(s, live);
    if (pid) signal(pid);
  }).catch((err) => console.warn('quit failed', id, err));
}

export async function forget(id: string) {
  const s = must(id);
  if (s.status !== 'exited') throw new Error('quit this session first, or archive it');
  sessions.remove(id);
  await dropAsides([s]);
  await rm(join(SESSIONS_DIR, id), { recursive: true, force: true });
  scheduleRerank();
  notify();
}

export function archive(id: string, archived: boolean) {
  const s = must(id);
  sessions.update(id, archivePatch(s, archived));
  notify();
}

export function setPriority(id: string, priority: unknown) {
  must(id);
  if (priority !== null && priority !== 'high' && priority !== 'low') throw new Error(`unknown priority ${JSON.stringify(priority)}`);
  sessions.update(id, { priority });
  notify();
  scheduleRerank();
}

// Solved and Dropped also archive the subtask, so it leaves the queue; Reopen brings it back.
export function resolve(id: string, state: unknown) {
  const s = must(id);
  if (!s.parent) throw new Error('only a subtask is marked solved or dropped');
  if (state !== null && state !== 'solved' && state !== 'dropped') throw new Error('unknown resolution');
  sessions.update(id, { ...archivePatch(s, !!state), resolution: state ? { state, at: Date.now() } : null });
  notify();
}

// Works where the branch is already checked out, else switches the main checkout to it.
export async function checkoutExistingBranch(repo: RepoView, branch: string) {
  const checkedOut = repo.worktrees.find((w) => w.branch === branch);
  if (checkedOut) return checkedOut.path;
  if (!(await listBranches(repo.path)).some((b) => b.name === branch)) throw new Error(`no branch named ${branch}`);
  const main = repo.worktrees.find((w) => w.isMain);
  if (!main) throw new Error('the main checkout is missing');
  const claudes = [...(await liveConversations()).values()].filter((p) => p.cwd === main.path || p.cwd.startsWith(`${main.path}/`));
  if (claudes.length) throw new Error(`Claude is running in ${main.path} on ${main.branch ?? 'a detached HEAD'}; switching it to ${branch} would change its files`);
  if (!(await isClean(main.path, { untracked: false }))) throw new Error(`${main.path} has uncommitted changes; commit or stash them first`);
  await switchBranch(main.path, branch);
  return main.path;
}

export function must(id: string) {
  const s = sessions.get(id);
  if (!s) throw new Error(`unknown session ${id}`);
  return s;
}
