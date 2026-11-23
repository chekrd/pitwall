import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { nextCycleDir, RPI_DIR, rpiPrompt, taskDirName } from './rpi.ts';
import { taskPrompt } from './schedule.ts';

// Another rpi cycle in a task that has one: the same worktree and branch, a task directory of its own.

interface CycleTask {
  repoId: number | null;
  worktree: string;
  title: string | null;
}

// What the New RPI cycle dialog shows before it sends: the folder the cycle would get, and what git has not committed.
export interface NewCycle {
  folder: string;
  changes: string[];
}

type Checkouts = readonly { id: number; worktrees: readonly { path: string; branch: string | null }[] }[];

// The name New task would have given the task's folder: its worktree's branch, or the task folder's name.
export function cycleBase(s: CycleTask, repos: Checkouts) {
  if (s.repoId === null) return taskDirName(null, basename(s.worktree));
  const branch = repos.find((r) => r.id === s.repoId)?.worktrees.find((w) => w.path === s.worktree)?.branch;
  return taskDirName(branch, s.title ?? basename(s.worktree));
}

// From where Claude starts, as rpi is told it.
export async function cycleFolder(s: CycleTask, repos: Checkouts) {
  const taken = (await readdir(join(s.worktree, RPI_DIR)).catch(() => [])) as string[];
  return `${RPI_DIR}/${nextCycleDir(cycleBase(s, repos), taken)}`;
}

export function cycleMessage(request: string, files: readonly string[], dir: string, invocation: string) {
  const text = taskPrompt(request, files);
  if (!text) throw new Error('the new cycle needs a request');
  return rpiPrompt(text, dir, invocation);
}
