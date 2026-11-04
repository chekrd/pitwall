import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { stopAdvice } from './advisor.ts';
import { clearings } from './clearing.ts';
import { alive, liveConversations, signal, type LiveProcess } from './conversations.ts';
import { SESSIONS_DIR } from './config.ts';
import { repos, sessions, type Session } from './db.ts';
import { stopExplanation } from './explain.ts';
import { changedFiles, isClean, removeWorktree, unpushedCommits } from './git.ts';
import * as ghostty from './ghostty.ts';
import * as terminal from './terminal.ts';
import { ttyOf, withoutAdopting } from './ingest.ts';
import { scheduleRerank } from './priority.ts';
import { claudeOf, dropAsides, must } from './sessions.ts';
import { notify, refreshWorkspace, repoView, taskWorktrees, workspace, type RepoView, type WorktreeView } from './workspace.ts';

// What reaches processes and terminals, which tests replace.
export const io = {
  live: liveConversations,
  signal,
  alive,
  ttyOf,
  closeTerminalsIn: ghostty.closeTerminalsIn,
  stopTerminal: terminal.stop,
};

// What Clear task would throw away or leave unpushed, for its confirmation.
export interface WorktreeLoss {
  branch: string | null;
  deletesBranch: boolean;
  // In a task folder, its loose files too.
  files: number;
  commits: number;
  // Clear keeps the worktree: it is the repository's main checkout or, with `shared`, another task works in it too.
  checkout?: true;
  shared?: true;
  // Its worktree or task folder was removed already, outside the board.
  gone?: boolean;
  subtasks: number;
  // A task across a folder of repos: what each of its worktrees would lose, and how many files lie outside them.
  repos?: { name: string; branch: string | null; deletesBranch: boolean; files: number; commits: number }[];
  loose?: number;
}

const stopWork = (o: Session) => {
  stopAdvice(o.id);
  stopExplanation(o.id);
};

export async function stopWorktree(worktree: string) {
  const gone = sessions.all().filter((s) => s.worktree === worktree);
  const live = await io.live();
  for (const s of gone) {
    const pid = claudeOf(s, live);
    if (pid) io.signal(pid, 'SIGTERM');
  }
  sessions.removeByWorktree(worktree);
  await Promise.all([...gone.map((s) => rm(join(SESSIONS_DIR, s.id), { recursive: true, force: true })), dropAsides(gone)]);
  scheduleRerank();
  notify();
}

// Its Claudes keep running, as Remove promises; what the board ran for its tasks goes with them.
export async function hideRepo(id: number) {
  const gone = sessions.all().filter((s) => s.repoId === id);
  for (const s of gone) stopWork(s);
  repos.hide(id);
  await Promise.all([...gone.map((s) => rm(join(SESSIONS_DIR, s.id), { recursive: true, force: true })), dropAsides(gone)]);
  scheduleRerank();
  notify();
}

async function waitForExit(pids: number[], timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (pids.some(io.alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  if (pids.some(io.alive)) throw new Error('Claude did not quit; nothing was deleted');
}

// git removes the whole directory, so a worktree inside it would lose its files.
function refuseNested(path: string) {
  const nested = workspace().flatMap((r) => r.worktrees.map((w) => w.path)).filter((p) => p.startsWith(`${path}/`));
  if (nested.length) throw new Error(`${nested.join(', ')} is a worktree inside this one; remove it first`);
}

async function removing(path: string, work: () => Promise<void>) {
  refuseNested(path);
  try {
    await withoutAdopting(path, work);
  } finally {
    await refreshWorkspace();
  }
}

export const clearing = clearings(notify);

const inside = (folder: string, path: string) => path === folder || path.startsWith(`${folder}/`);

// Every task in the path shows as clearing until the path is gone, or shows why it is not.
const clearingIn = (path: string, work: () => Promise<void>) =>
  clearing.run(path, sessions.all().filter((o) => inside(path, o.worktree)).map((o) => o.id), work);

export const removeWorktreeAndSessions = (repo: RepoView, path: string, opts: { force: boolean; deleteBranch: boolean }) =>
  clearingIn(path, () => removeWorktreeNow(repo, path, opts));

const claudesIn = async (path: string) => [...(await io.live()).values()].filter((p: LiveProcess) => inside(path, p.cwd));

// Claudes go first: one still running would write into the deleted tree and recreate parts of it.
async function removeWorktreeNow(repo: RepoView, path: string, opts: { force: boolean; deleteBranch: boolean }) {
  const worktree = repo.worktrees.find((w) => w.path === path);
  if (!worktree) throw new Error('worktree not found');
  if (worktree.isMain) throw new Error('this is the repository itself, not a worktree');
  await removing(path, async () => {
    if (!opts.force && !(await isClean(path))) {
      throw new Error('the worktree has uncommitted or untracked changes; tick Force to discard them');
    }
    const claudes = await claudesIn(path);
    const ttys = (await Promise.all(claudes.map((p) => io.ttyOf(p.pid)))).filter((t) => t !== null);
    for (const o of sessions.all().filter((o) => o.worktree === path)) stopWork(o);
    for (const p of claudes) io.signal(p.pid, 'SIGTERM');
    await waitForExit(claudes.map((p) => p.pid), 10_000);
    await io.closeTerminalsIn(path, ttys);
    const keepBranch = !worktree.branch || longLived(repo, worktree.branch);
    await removeWorktree(repo.path, path, { force: opts.force, deleteBranch: opts.deleteBranch && !keepBranch });
    await stopWorktree(path);
  });
}

const longLived = (repo: RepoView, branch: string) =>
  ['master', 'main', 'develop', 'trunk', repo.base, repo.base.replace(/^[^/]+\//, '')].includes(branch) || branch.startsWith('release/');

const subtasksOf = (id: string): Session[] => sessions.all().filter((o) => o.parent?.id === id).flatMap((o) => [o, ...subtasksOf(o.id)]);

// A worktree or task folder is the task's to remove only while no other task works in it, whether its Claude runs or
// not: New task on an existing branch starts in the worktree that already has the branch.
function sharedWith(s: Session) {
  const own = new Set([s.id, ...subtasksOf(s.id).map((o) => o.id)]);
  return sessions.all().some((o) => !own.has(o.id) && inside(s.worktree, o.worktree));
}

// What Clear task would do: remove the task folder, remove the worktree, or keep where the task works, which is the
// main checkout, a worktree another task shares, or one already gone.
type Plan =
  | { kind: 'folder' }
  | { kind: 'worktree'; repo: RepoView; worktree: WorktreeView }
  | { kind: 'gone' | 'checkout' | 'shared'; branch: string | null };

function planFor(s: Session): Plan {
  if (s.repoId === null) return sharedWith(s) ? { kind: 'shared', branch: null } : { kind: 'folder' };
  const repo = repoView(s.repoId);
  const worktree = repo?.worktrees.find((w) => w.path === s.worktree);
  if (!repo || !worktree) return { kind: 'gone', branch: null };
  if (worktree.isMain) return { kind: 'checkout', branch: worktree.branch };
  if (sharedWith(s)) return { kind: 'shared', branch: worktree.branch };
  return { kind: 'worktree', repo, worktree };
}

// A task in the main checkout keeps it, and its branch; so does one whose worktree another task shares.
export async function deleteWorktreeLoss(id: string): Promise<WorktreeLoss> {
  const s = must(id);
  if (s.parent) throw new Error(NOT_A_SUBTASK);
  const subtasks = subtasksOf(id).length;
  const plan = planFor(s);
  if (plan.kind === 'folder') return taskFolderLoss(s.worktree, subtasks);
  if (plan.kind !== 'worktree') {
    return {
      branch: plan.branch, deletesBranch: false, files: 0, commits: 0, checkout: true, subtasks,
      ...(plan.kind === 'gone' && { gone: true }), ...(plan.kind === 'shared' && { shared: true as const }),
    };
  }
  const { repo, worktree } = plan;
  const deletesBranch = !!worktree.branch && !longLived(repo, worktree.branch);
  const [files, commits] = await Promise.all([changedFiles(s.worktree), unpushedCommits(s.worktree)]);
  return { branch: worktree.branch, deletesBranch, files, commits, subtasks };
}

// The files in a task folder outside the worktrees given, and whether a repository lies among them at any depth.
export async function looseFiles(dir: string, worktrees: Set<string>): Promise<{ files: number; repository: boolean }> {
  let files = 0;
  let repository = false;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, e.name);
    if (worktrees.has(path)) continue;
    if (e.name === '.git') {
      repository = true;
    } else if (e.isDirectory()) {
      const inner = await looseFiles(path, worktrees);
      files += inner.files;
      repository ||= inner.repository;
    } else {
      files++;
    }
  }
  return { files, repository };
}

// Loose files go with the folder, unless a repository among them keeps it.
async function taskFolderLoss(folder: string, subtasks: number): Promise<WorktreeLoss> {
  const opened = taskWorktrees(folder);
  const repos = await Promise.all(opened.map(async ({ repo, worktree }) => {
    const deletesBranch = !!worktree.branch && !longLived(repo, worktree.branch);
    const [files, commits] = await Promise.all([changedFiles(worktree.path), unpushedCommits(worktree.path)]);
    return { name: repo.name, branch: worktree.branch, deletesBranch, files, commits };
  }));
  const left = await looseFiles(folder, new Set(opened.map(({ worktree }) => worktree.path)));
  const loose = left.repository ? 0 : left.files;
  return {
    branch: basename(folder),
    deletesBranch: repos.some((r) => r.deletesBranch),
    files: repos.reduce((n, r) => n + r.files, loose),
    commits: repos.reduce((n, r) => n + r.commits, 0),
    gone: !existsSync(folder),
    subtasks,
    repos,
    loose,
  };
}

// A task folder goes with every worktree in it, each with its branch, and then the folder itself, unless something
// other than those worktrees left a repository in it.
async function removeTaskFolder(folder: string) {
  try {
    await withoutAdopting(folder, async () => {
      const claudes = await claudesIn(folder);
      const ttys = (await Promise.all(claudes.map((p) => io.ttyOf(p.pid)))).filter((t) => t !== null);
      const gone = sessions.all().filter((o) => inside(folder, o.worktree));
      for (const o of gone) stopWork(o);
      for (const p of claudes) io.signal(p.pid, 'SIGTERM');
      await waitForExit(claudes.map((p) => p.pid), 10_000);
      await io.closeTerminalsIn(folder, ttys);
      await Promise.all(gone.map((o) => io.stopTerminal(o.id)));
      for (const { repo, worktree } of taskWorktrees(folder)) {
        await withoutAdopting(worktree.path, async () => {
          await removeWorktree(repo.path, worktree.path, { force: true, deleteBranch: !!worktree.branch && !longLived(repo, worktree.branch) });
          await stopWorktree(worktree.path);
        });
      }
      if ((await looseFiles(folder, new Set())).repository) console.warn(`kept ${folder}: a repository is still in it`);
      else await rm(folder, { recursive: true, force: true });
      await stopWorktree(folder);
    });
  } finally {
    await refreshWorkspace();
  }
}

const UNAPPROVED_LOSS = 'not everything is pushed: approve throwing it away in Clear task';

const losesWork = (loss: WorktreeLoss) => !loss.gone && !loss.checkout && loss.files + loss.commits > 0;

const NOT_A_SUBTASK = "a subtask works in its task's worktree; Quit Claude or Archive it instead";

// Clear task: in a worktree of its own, everything in it goes, the worktree and its branch too, subtasks with it. In
// the main checkout, which other Claudes may share, in a worktree another task works in too, or in one already
// removed, only the Claudes and terminals of the task and its subtasks go, with them. A hidden terminal goes by its
// name: the Claude in it may have moved on to another conversation, which leaves the task without its pid. A subtask
// is not cleared on its own: it shares its task's worktree. Work no remote has goes only with the approval the
// confirmation asks for.
export async function deleteWorktree(id: string, { discard = false } = {}) {
  const s = must(id);
  if (s.parent) throw new Error(NOT_A_SUBTASK);
  if (!discard && losesWork(await deleteWorktreeLoss(id))) throw new Error(UNAPPROVED_LOSS);
  const plan = planFor(s);
  if (plan.kind === 'folder') return clearingIn(s.worktree, () => removeTaskFolder(s.worktree));
  if (plan.kind === 'worktree') return clearingIn(s.worktree, () => removeWorktreeNow(plan.repo, s.worktree, { force: true, deleteBranch: true }));
  const gone = [s, ...subtasksOf(id)];
  return clearing.run(`task:${id}`, gone.map((o) => o.id), () => stopTask(gone));
}

async function stopTask(gone: Session[]) {
  for (const o of gone) stopWork(o);
  const live = await io.live();
  const claudes = gone.flatMap((o) => {
    const pid = claudeOf(o, live);
    return pid ? [{ pid, tty: o.tty }] : [];
  });
  const ttys = (await Promise.all(claudes.map((c) => c.tty ?? io.ttyOf(c.pid)))).filter((t) => t !== null);
  for (const { pid } of claudes) io.signal(pid, 'SIGTERM');
  await waitForExit(claudes.map((c) => c.pid), 10_000);
  if (ttys.length) await io.closeTerminalsIn(null, ttys);
  await Promise.all(gone.map((o) => io.stopTerminal(o.id)));
  for (const o of gone) sessions.remove(o.id);
  await Promise.all([...gone.map((o) => rm(join(SESSIONS_DIR, o.id), { recursive: true, force: true })), dropAsides(gone)]);
  scheduleRerank();
  notify();
}
