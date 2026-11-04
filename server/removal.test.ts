import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import type { LiveProcess } from './conversations.ts';
import { repos, sessions } from './db.ts';
import { deleteWorktree, deleteWorktreeLoss, io, looseFiles } from './removal.ts';
import { claudeOf } from './sessions.ts';
import { makeTaskFolder, openWorktree } from './folderTasks.ts';
import { refreshWorkspace } from './workspace.ts';

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

function repoIn(folder: string, name: string) {
  const main = join(folder, name);
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'readme.txt'), `${name}\n`);
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  git(main, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return main;
}

// Claudes, signals and terminals are played here: no real process is signalled and no terminal is touched.
let live = new Map<string, LiveProcess>();
let signalled: number[] = [];
let closed: { dir: string | null; ttys: string[] }[] = [];
beforeEach(() => {
  live = new Map();
  signalled = [];
  closed = [];
  io.live = async () => live;
  io.signal = (pid) => {
    signalled.push(pid);
    live = new Map([...live].filter(([, p]) => p.pid !== pid));
    return true;
  };
  io.alive = (pid) => [...live.values()].some((p) => p.pid === pid);
  io.ttyOf = async () => null;
  io.closeTerminalsIn = async (dir, ttys) => {
    closed.push({ dir, ttys });
    return 0;
  };
  io.stopTerminal = async () => {};
});

const running = (conversation: string, pid: number, cwd: string) => live.set(conversation, { pid, cwd, status: 'idle', waitingFor: null });

function task(id: string, repoId: number | null, worktree: string, pid: number | null, parent?: string) {
  sessions.insert({ id, repoId, worktree, cwd: worktree, pid, tty: pid ? `/dev/ttys${pid}` : null, title: id, firstPrompt: 'do it', status: pid ? 'idle' : 'exited' });
  if (parent) sessions.update(id, { parent: { id: parent, basis: 'b', finding: 0, title: 't', kind: 'accept', text: 'x' } });
}

async function repoWithWorktree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-removal-')));
  const main = repoIn(root, 'app');
  const id = repos.add(main);
  const worktree = join(root, 'worktrees', 'feature');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  await refreshWorkspace();
  return { main, id, worktree };
}

test('Clear task leaves a worktree another task works in, stopping only its own Claude', async () => {
  const { main, id, worktree } = await repoWithWorktree();
  task('first', id, worktree, 9101);
  task('second', id, worktree, 9102);
  task('first-sub', id, worktree, null, 'first');
  running('first', 9101, worktree);
  running('second', 9102, worktree);

  const loss = await deleteWorktreeLoss('second');
  assert.deepEqual(loss, { branch: 'feature', deletesBranch: false, files: 0, commits: 0, checkout: true, subtasks: 0, shared: true });
  await deleteWorktree('second');

  assert.ok(existsSync(worktree), 'the worktree stays');
  assert.equal(git(main, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/feature'), 'feature', 'its branch stays');
  assert.deepEqual(signalled, [9102]);
  assert.deepEqual(closed, [{ dir: null, ttys: ['/dev/ttys9102'] }]);
  assert.equal(sessions.get('second'), undefined);
  assert.ok(sessions.get('first') && sessions.get('first-sub'), "the other task and its subtask stay");

  // Once it is the only task there, with its subtask, the worktree and its branch go.
  assert.equal((await deleteWorktreeLoss('first')).shared, undefined);
  await deleteWorktree('first', { discard: true });
  assert.ok(!existsSync(worktree));
  assert.equal(git(main, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/feature'), '');
  assert.deepEqual(signalled, [9102, 9101]);
  assert.equal(sessions.get('first'), undefined);
  assert.equal(sessions.get('first-sub'), undefined);
});

test('an archived task in the worktree keeps it too', async () => {
  const { id, worktree } = await repoWithWorktree();
  task('old', id, worktree, null);
  sessions.update('old', { archived: true });
  task('new', id, worktree, null);
  assert.equal((await deleteWorktreeLoss('new')).shared, true);
  await deleteWorktree('new');
  assert.ok(existsSync(worktree));
  assert.ok(sessions.get('old'));
});

test('a stored pid counts as the task\'s Claude only while a live Claude runs it in that task', () => {
  task('pid-a', 1, '/nowhere', 9211);
  task('pid-b', 1, '/nowhere', 9212);
  const a = sessions.get('pid-a')!;
  const b = sessions.get('pid-b')!;
  const p = (pid: number): LiveProcess => ({ pid, cwd: '/nowhere', status: 'idle', waitingFor: null });
  assert.equal(claudeOf(a, new Map([['pid-a', p(9211)]])), 9211);
  assert.equal(claudeOf(a, new Map([['pid-b', p(9211)]])), null, "the pid runs another task's conversation");
  assert.equal(claudeOf(b, new Map([['pid-a', p(9211)]])), null, 'the pid is no Claude any more');
  assert.equal(claudeOf(a, new Map([['after-clear', p(9211)]])), 9211, 'a conversation no task has yet, as after /clear');
});

test('Clear task does not signal a stored pid that is no longer the task\'s Claude', async () => {
  const { main, id } = await repoWithWorktree();
  task('gone-pid', id, main, 9201);
  task('other', id, main, 9202);
  running('other', 9201, main);
  await deleteWorktree('gone-pid');
  assert.deepEqual(signalled, [], 'Clear in the main checkout signalled a pid another task has');
  assert.equal(sessions.get('gone-pid'), undefined);
});

test('a task folder counts the files outside its worktrees and keeps a folder that holds a repository at any depth', async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-folder-')));
  for (const name of ['web', 'api']) repos.add(repoIn(folder, name));
  await refreshWorkspace();
  const path = await makeTaskFolder(folder, 'cross');
  await openWorktree({ repo: 'api', task_folder: path });
  mkdirSync(join(path, 'notes', 'deep'), { recursive: true });
  writeFileSync(join(path, 'plan.md'), 'plan\n');
  writeFileSync(join(path, 'notes', 'deep', 'a.txt'), 'a\n');
  task('folder-task', null, path, null);

  const loss = await deleteWorktreeLoss('folder-task');
  assert.equal(loss.loose, 2);
  assert.equal(loss.files, 2);
  await assert.rejects(deleteWorktree('folder-task'), /not everything is pushed/);
  assert.ok(existsSync(join(path, 'plan.md')));

  mkdirSync(join(path, 'notes', 'deep', 'vendored'));
  git(join(path, 'notes', 'deep', 'vendored'), 'init', '-q');
  assert.deepEqual(await looseFiles(path, new Set([join(path, 'api')])), { files: 2, repository: true });
  assert.equal((await deleteWorktreeLoss('folder-task')).loose, 0, 'a kept folder loses no loose files');
  await deleteWorktree('folder-task');
  assert.ok(!existsSync(join(path, 'api')), 'its worktree goes');
  assert.ok(existsSync(join(path, 'plan.md')), 'the folder with a repository in it stays');
  assert.equal(sessions.get('folder-task'), undefined);
});

test('a task folder with nothing but its worktrees goes whole', async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-folder-')));
  for (const name of ['web', 'api']) repos.add(repoIn(folder, name));
  await refreshWorkspace();
  const path = await makeTaskFolder(folder, 'tidy');
  await openWorktree({ repo: 'web', task_folder: path });
  task('tidy-task', null, path, 9301);
  running('tidy-task', 9301, path);
  assert.equal((await deleteWorktreeLoss('tidy-task')).loose, 0);
  await deleteWorktree('tidy-task', { discard: true });
  assert.ok(!existsSync(path));
  assert.deepEqual(signalled, [9301]);
});

test('a task folder another task works in stays', async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-folder-')));
  for (const name of ['web', 'api']) repos.add(repoIn(folder, name));
  await refreshWorkspace();
  const path = await makeTaskFolder(folder, 'both');
  task('one', null, path, null);
  task('two', null, path, null);
  assert.equal((await deleteWorktreeLoss('one')).shared, true);
  await deleteWorktree('one');
  assert.ok(existsSync(path));
  assert.ok(sessions.get('two'));
});
