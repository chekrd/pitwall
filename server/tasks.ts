import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import type { RouteInput } from './contract.ts';
import { schedules, sessions } from './db.ts';
import { makeTaskFolder } from './folderTasks.ts';
import { addWorktree } from './git.ts';
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

export const startRepoTask = ({ branch = '', path = '', prompt = '', model = '', effort = '', existingBranch = false, ...body }: RouteInput<'POST /api/worktrees'>) =>
  startTask({ kind: 'repo', ...body, branch, path, prompt, model, effort, existingBranch });

export const startFolderTask = ({ prompt = '', model = '', effort = '', ...body }: RouteInput<'POST /api/folder-tasks'>) => startTask({ kind: 'folder', ...body, prompt, model, effort });

// A task across a folder of repos starts in an empty task folder; Claude opens a worktree in each repo it changes.
async function startTask(req: NewTask) {
  const { model, effort } = chosenModel(req);
  const name = req.name.trim();
  const prompt = taskPrompt(req.prompt ?? '', await checkUploads(req.files)) || undefined;
  if (req.kind === 'folder') {
    if (!name) throw new Error('name is required');
    const path = await makeTaskFolder(req.folder, name);
    const { model: fallback, real, effortOf } = await resolve(req.folder);
    const running = model ? real(model) : fallback;
    const sessionId = await S.startClaude({
      repoId: null, worktree: path, prompt, title: name, model, effort, running: { model: running, effort: effort ?? effortOf(running) }, scheduled: req.scheduled,
    });
    return { path, sessionId };
  }
  const repo = repoView(req.repoId);
  if (!repo) throw new Error('unknown repo');
  const branch = req.branch?.trim();
  let path: string;
  if (req.existingBranch) {
    if (!branch) throw new Error('pick a branch');
    path = await S.checkoutExistingBranch(repo, branch);
  } else {
    if (!name) throw new Error('name is required');
    const wanted = req.path?.trim().replace(/^~(?=\/|$)/, homedir()) || undefined;
    if (wanted && !isAbsolute(wanted)) throw new Error('the worktree path must be absolute');
    path = await addWorktree(repo.path, {
      branch: branch || name, task: name, base: repo.baseBranch, root: repo.defaultWorktreeRoot, path: wanted,
    });
  }
  await refreshWorkspace();
  const setup = req.existingBranch ? null : repo.setupCommand;
  const { model: fallback, real, effortOf } = await resolve(repo.path);
  const running = model ? real(model) : fallback;
  const sessionId = await S.startClaude({
    repoId: repo.id, worktree: path, prompt, title: req.scheduled || !req.existingBranch ? name : '', setup, model, effort,
    running: { model: running, effort: effort ?? effortOf(running) }, scheduled: req.scheduled,
  });
  return { path, sessionId };
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
  start: async (s, name, scheduled) => (await startTask({ ...s.task, name, scheduled })).sessionId,
  taken: takenNames,
});
