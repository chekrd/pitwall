import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cycleBase, cycleFolder, cycleMessage } from './cycles.ts';
import { BOARD_HANDOFF, RPI_DIR } from './rpi.ts';

const repos = (path: string, branch: string | null) => [{ id: 1, worktrees: [{ path: '/Users/me/code/app', branch: 'main' }, { path, branch }] }];

test("a new cycle's folder is named as New task named the first: the worktree's branch with / as -, or the task folder's name", () => {
  const path = '/Users/me/code/worktrees/csv/app';
  assert.equal(cycleBase({ repoId: 1, worktree: path, title: 'CSV export' }, repos(path, 'feature/csv-export')), 'feature-csv-export');
  assert.equal(cycleBase({ repoId: 1, worktree: path, title: 'CSV export' }, repos(path, null)), 'csv-export', 'a detached worktree goes by the task');
  assert.equal(cycleBase({ repoId: null, worktree: '/Users/me/code/worktrees/search', title: 'Search page' }, []), 'search');
});

test("a new cycle's folder skips every name under the checkout's artifacts folder, an empty folder included, and starts at -2 without one", async () => {
  const worktree = mkdtempSync(join(tmpdir(), 'pitwall-cycle-'));
  const repo = repos(worktree, 'csv-export');
  const task = { repoId: 1, worktree, title: null };
  assert.equal(await cycleFolder(task, repo), `${RPI_DIR}/csv-export-2`, 'no artifacts folder yet');
  mkdirSync(join(worktree, RPI_DIR, 'csv-export'), { recursive: true });
  writeFileSync(join(worktree, RPI_DIR, 'csv-export', '01-request-csv.md'), '# Request');
  mkdirSync(join(worktree, RPI_DIR, 'csv-export-2'));
  mkdirSync(join(worktree, RPI_DIR, 'csv-export-4'));
  assert.equal(await cycleFolder(task, repo), `${RPI_DIR}/csv-export-3`);
});

test("a new cycle's request goes as New task's RPI prompt does: one rpi command naming the folder, the rest and the files after it, then the handoff", () => {
  assert.equal(cycleMessage('Add a PDF export\nSame columns as the CSV.', ['/Users/me/Library/Caches/pitwall/uploads/u1/mock.png'], `${RPI_DIR}/csv-export-2`, '/rpi:rpi'), [
    `/rpi:rpi Add a PDF export; task directory: ${RPI_DIR}/csv-export-2`,
    'Same columns as the CSV.',
    '',
    '/Users/me/Library/Caches/pitwall/uploads/u1/mock.png',
    '',
    BOARD_HANDOFF,
  ].join('\n'));
  assert.throws(() => cycleMessage('  ', [], `${RPI_DIR}/x-2`, '/rpi'), /needs a request/);
});
