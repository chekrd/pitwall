import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve as pathResolve } from 'node:path';
import type { RouteInput } from './contract.ts';
import { schedules, sessions } from './db.ts';
import { makeTaskFolder } from './folderTasks.ts';
import { addWorktree, validBranch } from './git.ts';
import { ALIASES, EFFORTS, resolver, settingsFor } from './models.ts';
import { scheduler, taskPrompt, type Scheduled, type TaskRequest } from './schedule.ts';
import * as S from './sessions.ts';
import { checkUploads } from './uploads.ts';
import { notify, refreshWorkspace, repoView, workspace } from './workspace.ts';

const MODEL = /^[A-Za-z0-9._-]+(\[1m\])?$/;

const resolve = async (repoPath: string) =>
  resolver(await settingsFor(repoPath), sessions.all().toSorted((a, b) => b.updatedAt - a.updatedAt));

export async function modelChoices(path: string) {
  const { model, real, effortOf } = await resolve(path);
  const models: Record<string, string | null> = Object.fromEntries([['', model], ...ALIASES.map((a) => [a, real(a)])]);
  return { models, efforts: Object.fromEntries(Object.entries(models).map(([k, m]) => [k, effortOf(m)])) };
}

const chosenModel = (body: { model?: string; effort?: string }) => {
  const model = body.model?.trim() || undefined;
  const effort = body.effort || undefined;
  if (model && !MODEL.test(model)) throw new Error(`unknown model ${model}`);
  if (effort && !EFFORTS.includes(effort)) throw new Error(`unknown effort ${effort}`);
  return { model, effort };
};

type NewTask = TaskRequest & { name: string; scheduled?: Scheduled };

const inBackground = ({ path, sessionId, ready }: Awaited<ReturnType<typeof startTask>>) => {
  void ready.catch((err: unknown) => S.startFailed(sessionId, err instanceof Error ? err.message : String(err)));
  return { path, sessionId };
};

export const startRepoTask = async ({ branch = '', path = '', prompt = '', model = '', effort = '', existingBranch = false, ...body }: RouteInput<'POST /api/worktrees'>) =>
  inBackground(await startTask({ kind: 'repo', ...body, branch, path, prompt, model, effort, existingBranch }));

export const startFolderTask = async ({ prompt = '', model = '', effort = '', ...body }: RouteInput<'POST /api/folder-tasks'>) =>
  inBackground(await startTask({ kind: 'folder', ...body, prompt, model, effort }));

// A task across a folder of repos starts in an empty task folder; Claude opens a worktree in each repo it changes.
// A new worktree fetches from origin, which takes seconds, so that task starts with its card up and `ready` still to
// come. What New task can be told right away it is told here, in the form.
async function startTask(req: NewTask) {
  const { model, effort } = chosenModel(req);
  const name = req.name.trim();
  const files = await checkUploads(req.files);
  const prompt = taskPrompt(req.prompt ?? '', files) || undefined;
  if (req.kind === 'folder') {
    if (!name) throw new Error('name is required');
    const path = await makeTaskFolder(req.folder, name);
    const { model: fallback, real, effortOf } = await resolve(req.folder);
    const running = model ? real(model) : fallback;
    const sessionId = await S.startClaude({
      repoId: null, worktree: path, prompt, title: name, model, effort, running: { model: running, effort: effort ?? effortOf(running) }, scheduled: req.scheduled,
    });
    return { path, sessionId, ready: Promise.resolve() };
  }
  const repo = repoView(req.repoId);
  if (!repo) throw new Error('unknown repo');
  const branch = req.branch?.trim();
  const { model: fallback, real, effortOf } = await resolve(repo.path);
  const running = model ? real(model) : fallback;
  const claude = { repoId: repo.id, prompt, model, effort, running: { model: running, effort: effort ?? effortOf(running) }, scheduled: req.scheduled };
  if (req.existingBranch) {
    if (!branch) throw new Error('pick a branch');
    const path = await S.checkoutExistingBranch(repo, branch);
    await refreshWorkspace();
    const sessionId = await S.startClaude({ ...claude, worktree: path, title: req.scheduled ? name : '' });
    return { path, sessionId, ready: Promise.resolve() };
  }
  if (!name) throw new Error('name is required');
  const wanted = req.path?.trim().replace(/^~(?=\/|$)/, homedir()) || undefined;
  if (wanted && !isAbsolute(wanted)) throw new Error('the worktree path must be absolute');
  const newBranch = branch || name;
  if (!(await validBranch(newBranch))) throw new Error(`${newBranch} cannot name a branch`);
  const path = wanted ? pathResolve(wanted) : join(repo.defaultWorktreeRoot, name.replaceAll('/', '-'), basename(repo.path));
  const request = { repoId: repo.id, name, branch: branch ?? '', path: req.path ?? '', prompt: req.prompt ?? '', files, model: req.model ?? '', effort: req.effort ?? '' };
  const { id, ready } = S.startAfter({ ...claude, worktree: path, title: name, setup: repo.setupCommand }, request, 'Creating the worktree', async () => {
    await addWorktree(repo.path, { branch: newBranch, task: name, base: repo.baseBranch, root: repo.defaultWorktreeRoot, path });
    await refreshWorkspace();
  });
  return { path, sessionId: id, ready };
}

// Every name a run could clash with: tasks, their worktree folders and the branches checked out.
const takenNames = () => new Set([
  ...sessions.all().flatMap((s) => [s.title ?? '', s.worktree.split('/').at(-1)!]),
  ...workspace().flatMap((r) => r.worktrees.flatMap((w) => [w.branch ?? '', w.path.split('/').at(-2)!])),
]);

export const plan = scheduler({
  list: schedules.all,
  save: (s) => {
    schedules.save(s);
    notify();
  },
  // A run that fails is the schedule's to report, on its last run.
  start: async (s, name, scheduled) => {
    const { sessionId, ready } = await startTask({ ...s.task, name, scheduled });
    await ready.catch((err: unknown) => {
      sessions.remove(sessionId);
      notify();
      throw err;
    });
    return sessionId;
  },
  taken: takenNames,
});
