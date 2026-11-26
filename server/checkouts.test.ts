import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownCheckouts } from './checkouts.ts';

const repo = (path: string, main: string, others: string[] = []) =>
  ({ path, worktrees: [{ path: main, isMain: true }, ...others.map((p) => ({ path: p, isMain: false }))] });

test('a registered path now holding a worktree of a registered repository is dropped, the repository kept', () => {
  const main = repo('/code/api', '/code/api', ['/code/worktrees/t/api']);
  const clone = repo('/code/worktrees/t/api', '/code/api', ['/code/worktrees/t/api']);
  assert.deepEqual(ownCheckouts([clone, main]), [main]);
});

test('a path whose main checkout is not registered, or that failed to list, stays', () => {
  const lone = repo('/code/worktrees/t/api', '/elsewhere/api');
  const failed = { path: '/code/broken', worktrees: [] };
  assert.deepEqual(ownCheckouts([lone, failed]), [lone, failed]);
});
