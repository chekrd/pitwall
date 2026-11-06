import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { repos, sessions } from './db.ts';
import { pause, pauseState, settleStarting, startAfter, startFailed } from './sessions.ts';
import { startRepoTask } from './tasks.ts';
import { refreshWorkspace } from './workspace.ts';

const run = promisify(execFile);
const request = { repoId: 1, name: 'n', branch: '', path: '', prompt: 'p', files: [], model: '', effort: '' };

async function repoWithoutOrigin() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-tasks-')));
  const path = join(root, 'app');
  await mkdir(path);
  const git = (...args: string[]) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: path });
  await git('init', '--quiet', '--initial-branch=main');
  await git('commit', '--quiet', '--allow-empty', '-m', 'first');
  await git('remote', 'add', 'origin', join(root, 'no-such-origin'));
  repos.addFound(path);
  await refreshWorkspace();
  return { root, id: repos.all().find((r) => r.path === path)!.id };
}

async function settled(id: string) {
  while (!sessions.get(id)?.starting?.error) await new Promise((done) => setTimeout(done, 20));
  return sessions.get(id)!;
}

test('a new worktree is made behind the card: the task is there at once, and a worktree that fails leaves the task with why and what was sent', async () => {
  const { root, id: repoId } = await repoWithoutOrigin();
  const { sessionId, path } = await startRepoTask({ repoId, name: 'feature/one', prompt: 'Do it', files: [], model: 'sonnet' });
  assert.equal(path, join(root, 'worktrees', 'feature-one', 'app'), 'where git wt would put it');
  const s = sessions.get(sessionId)!;
  assert.deepEqual([s.status, s.title, s.firstPrompt, s.worktree, s.activity?.step], ['working', 'feature/one', 'Do it', path, 'Creating the worktree']);
  assert.equal(s.starting?.error, null);

  const failed = await settled(sessionId);
  assert.equal(failed.status, 'exited');
  assert.equal(failed.activity, null);
  assert.match(failed.starting!.error!, /origin cannot be reached/);
  assert.deepEqual(failed.starting!.request, { repoId, name: 'feature/one', branch: '', path: '', prompt: 'Do it', files: [], model: 'sonnet', effort: '' });
  sessions.remove(sessionId);
});

test('what New task can be told at once is refused in the form, and no task comes of it', async () => {
  const { id: repoId } = await repoWithoutOrigin();
  await assert.rejects(startRepoTask({ repoId, name: 'bad..name' }), /bad\.\.name cannot name a branch/);
  await assert.rejects(startRepoTask({ repoId, name: 'ok', branch: 'also..bad' }), /also\.\.bad cannot name a branch/);
  await assert.rejects(startRepoTask({ repoId, name: 'ok', path: 'relative/path' }), /must be absolute/);
  await assert.rejects(startRepoTask({ repoId, name: '' }), /name is required/);
  assert.deepEqual(sessions.all().filter((s) => s.repoId === repoId), []);
});

test('a task whose preparation a restart cut off is marked as failed, one that already failed keeps its reason, and Pause leaves both alone', async () => {
  const cut = startAfter({ repoId: null, worktree: '/nowhere/cut', prompt: 'p' }, request, 'Creating the worktree', () => new Promise(() => {}));
  const told = startAfter({ repoId: null, worktree: '/nowhere/told', prompt: 'p' }, request, 'Creating the worktree', () => new Promise(() => {}));
  startFailed(told.id, 'no such branch');
  pause();
  assert.deepEqual(pauseState().stopping, []);
  settleStarting();
  assert.match(sessions.get(cut.id)!.starting!.error!, /Pitwall restarted/);
  assert.equal(sessions.get(cut.id)!.status, 'exited');
  assert.equal(sessions.get(told.id)!.starting!.error, 'no such branch');
  sessions.remove(cut.id);
  sessions.remove(told.id);
});

test('a task removed while its worktree is made starts no Claude', async () => {
  let finish!: () => void;
  const { id, ready } = startAfter({ repoId: null, worktree: '/nowhere/removed', prompt: 'p' }, request, 'Creating the worktree', () => new Promise<void>((done) => (finish = done)));
  sessions.remove(id);
  finish();
  await ready;
  assert.equal(sessions.get(id), undefined);
});
