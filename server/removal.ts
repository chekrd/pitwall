import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { clearings } from './clearing.ts';
import { alive, liveConversations, signal, type LiveProcess } from './conversations.ts';
import { SESSIONS_DIR } from './config.ts';
import { repos, sessions, type Session } from './db.ts';
import { changedFiles, isClean, removeWorktree, unpushedCommits } from './git.ts';
import { looseFiles } from './looseFiles.ts';
import * as ghostty from './ghostty.ts';
import * as terminal from './terminal.ts';
import * as tmux from './tmux.ts';
import { ttyOf, withoutAdopting } from './ingest.ts';
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
  tmuxTtys: async () => new Set((await tmux.panes().catch(() => new Map())).keys()),
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
  // A task across a folder of repos: what each of its worktrees would lose, and how many files lie outside them.
  repos?: { name: string; branch: string | null; deletesBranch: boolean; files: number; commits: number }[];
  loose?: number;
}

// Tabs Clear task could not close, which stay open in the removed directory or on the ttys its Claudes had, until
// dismissed. Ghostty refuses every Apple event without the Automation permission, so it cannot be asked which tabs those are.
export interface TerminalNotice {
  id: string;
  tasks: string[];
  dir: string | null;
  ttys: string[];
  permission: boolean;
  error: string;
}

let notices: TerminalNotice[] = [];
let noticeSerial = 0;

export const terminalNotices = () => notices;

export function dismissTerminalNotice(id: string) {
  const before = notices.length;
  notices = notices.filter((n) => n.id !== id);
  if (notices.length !== before) notify();
}

// A tmux pane's tty is no terminal tab: its tmux session ends with the Claude in it.
const tabTtys = async (ttys: string[]) => {
  const panes = await io.tmuxTtys();
  return ttys.filter((t) => !panes.has(t));
};

const closeTerminals = (tasks: Session[], dir: string | null, ttys: string[]) =>
  io.closeTerminalsIn(dir, ttys).catch((err: unknown) => {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`left terminals open in ${dir ?? ttys.join(', ')}: ${error}`);
    notices = [...notices, { id: String(++noticeSerial), tasks: tasks.length ? tasks.map((o) => o.title || basename(o.worktree)) : [basename(dir ?? '')], dir, ttys, permission: err instanceof ghostty.NotPermitted, error }];
    notify();
  });

export async function stopWorktree(worktree: string) {
  const gone = sessions.all().filter((s) => s.worktree === worktree);
  const live = await io.live();
  for (const s of gone) {
    const pid = claudeOf(s, live);
    if (pid) io.signal(pid, 'SIGTERM');
  }
  sessions.removeByWorktree(worktree);
  await Promise.all([...gone.map((s) => rm(join(SESSIONS_DIR, s.id), { recursive: true, force: true })), dropAsides(gone)]);
  notify();
}

// Its Claudes keep running, as Remove promises; what the board ran for its tasks goes with them.
export async function hideRepo(id: number) {
  const gone = sessions.all().filter((s) => s.repoId === id);
  repos.hide(id);
  await Promise.all([...gone.map((s) => rm(join(SESSIONS_DIR, s.id), { recursive: true, force: true })), dropAsides(gone)]);
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
    const ttys = await tabTtys((await Promise.all(claudes.map((p) => io.ttyOf(p.pid)))).filter((t) => t !== null));
    const tasks = sessions.all().filter((o) => o.worktree === path);
    for (const p of claudes) io.signal(p.pid, 'SIGTERM');
    await waitForExit(claudes.map((p) => p.pid), 10_000);
    await closeTerminals(tasks, path, ttys);
    const keepBranch = !worktree.branch || longLived(repo, worktree.branch);
    await removeWorktree(repo.path, path, { force: opts.force, deleteBranch: opts.deleteBranch && !keepBranch });
    await stopWorktree(path);
  });
}

const longLived = (repo: RepoView, branch: string) =>
  ['master', 'main', 'develop', 'trunk', repo.base, repo.base.replace(/^[^/]+\//, '')].includes(branch) || branch.startsWith('release/');

// A worktree or task folder is the task's to remove only while no other task works in it, whether its Claude runs or
// not: New task on an existing branch starts in the worktree that already has the branch.
const sharedWith = (s: Session) => sessions.all().some((o) => o.id !== s.id && inside(s.worktree, o.worktree));

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
  const plan = planFor(s);
  if (plan.kind === 'folder') return taskFolderLoss(s.worktree);
  if (plan.kind !== 'worktree') {
    return {
      branch: plan.branch, deletesBranch: false, files: 0, commits: 0, checkout: true,
      ...(plan.kind === 'gone' && { gone: true }), ...(plan.kind === 'shared' && { shared: true as const }),
    };
  }
  const { repo, worktree } = plan;
  const deletesBranch = !!worktree.branch && !longLived(repo, worktree.branch);
  const [files, commits] = await Promise.all([changedFiles(s.worktree), unpushedCommits(s.worktree)]);
  return { branch: worktree.branch, deletesBranch, files, commits };
}

// Loose files go with the folder, unless a repository among them keeps it.
async function taskFolderLoss(folder: string): Promise<WorktreeLoss> {
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
      const ttys = await tabTtys((await Promise.all(claudes.map((p) => io.ttyOf(p.pid)))).filter((t) => t !== null));
      const gone = sessions.all().filter((o) => inside(folder, o.worktree));
      for (const p of claudes) io.signal(p.pid, 'SIGTERM');
      await waitForExit(claudes.map((p) => p.pid), 10_000);
      await closeTerminals(gone, folder, ttys);
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

// Clear task: in a worktree of its own, everything in it goes, the worktree and its branch too. In the main checkout,
// which other Claudes may share, in a worktree another task works in too, or in one already removed, only the task's
// Claude and terminals go, with the task. A hidden terminal goes by its name: the Claude in it may have moved on to
// another conversation, which leaves the task without its pid. Work no remote has goes only with the approval the
// confirmation asks for.
export async function deleteWorktree(id: string, { discard = false } = {}) {
  const s = must(id);
  if (!discard && losesWork(await deleteWorktreeLoss(id))) throw new Error(UNAPPROVED_LOSS);
  const plan = planFor(s);
  if (plan.kind === 'folder') return clearingIn(s.worktree, () => removeTaskFolder(s.worktree));
  if (plan.kind === 'worktree') return clearingIn(s.worktree, () => removeWorktreeNow(plan.repo, s.worktree, { force: true, deleteBranch: true }));
  return clearing.run(`task:${id}`, [id], () => stopTask(s));
}

async function stopTask(s: Session) {
  const pid = claudeOf(s, await io.live());
  const tty = pid && (s.tty ?? (await io.ttyOf(pid)));
  const ttys = await tabTtys(tty ? [tty] : []);
  if (pid) io.signal(pid, 'SIGTERM');
  await waitForExit(pid ? [pid] : [], 10_000);
  if (ttys.length) await closeTerminals([s], null, ttys);
  await io.stopTerminal(s.id);
  sessions.remove(s.id);
  await Promise.all([rm(join(SESSIONS_DIR, s.id), { recursive: true, force: true }), dropAsides([s])]);
  notify();
}
