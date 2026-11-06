import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addWorktree, changedFiles, detectBase, fullDiff, pullRequestUrlOf, unpushedCommits, upstreamOf } from './git.ts';

const GIT_WT = join(import.meta.dirname, '..', 'scripts', 'git-wt');
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const wt = (cwd: string, ...args: string[]) => execFileSync(GIT_WT, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir: string, file: string, content: string) => writeFileSync(join(dir, file), content);

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-git-')));
  const main = join(root, 'app');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'master');
  write(main, 'a.txt', 'one\ntwo\nthree\n');
  write(main, '.gitignore', '*.log\n.env\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  return { root, main };
}

test('the diff merges committed, staged, unstaged and untracked changes and leaves the index alone', async () => {
  const { main } = repo();
  git(main, 'switch', '-qc', 'feature');
  write(main, 'b.txt', 'committed\n');
  git(main, 'add', 'b.txt');
  git(main, 'commit', '-qm', 'b');
  write(main, 'c.txt', 'staged\n');
  git(main, 'add', 'c.txt');
  write(main, 'a.txt', 'one\nTWO\nthree\n');
  write(main, 'd.txt', 'untracked\n');
  write(main, 'e.log', 'ignored\n');
  const indexBefore = git(main, 'diff', '--cached', '--name-only');

  const diff = await fullDiff(main, 'master');
  assert.deepEqual(diff.stat, { files: 4, insertions: 4, deletions: 1 });
  for (const file of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) assert.match(diff.patch, new RegExp(`b/${file}`));
  assert.doesNotMatch(diff.patch, /e\.log/);
  assert.equal(git(main, 'diff', '--cached', '--name-only'), indexBefore);

  const one = await fullDiff(main, 'master', { paths: ['a.txt'] });
  assert.equal(one.stat.files, 1);
  assert.match(one.patch, / one\n-two\n\+TWO\n three/);
});

test('the diff compares against origin\'s base, not a local base branch with commits origin lacks', async () => {
  const { main } = repo();
  git(main, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
  write(main, 'local.txt', 'only on the local master\n');
  git(main, 'add', 'local.txt');
  git(main, 'commit', '-qm', 'local');
  git(main, 'switch', '-qc', 'feature');
  write(main, 'b.txt', 'feature\n');

  const diff = await fullDiff(main, 'master');
  assert.equal(diff.base, 'origin/master');
  assert.equal(diff.mergeBase, git(main, 'rev-parse', 'origin/master'));
  assert.deepEqual(diff.stat, { files: 2, insertions: 2, deletions: 0 });
  assert.equal((await fullDiff(main, 'origin/master')).base, 'origin/master');
});

// The edit keeps the size and the mtime of a.txt, and the index looks written in that same second, so only a
// re-read of the file shows the change.
test('a same-size edit made in the second the index was written is in the diff', async () => {
  const { main } = repo();
  const then = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000);
  utimesSync(join(main, 'a.txt'), then, then);
  git(main, 'update-index', '--refresh');
  write(main, 'a.txt', 'one\nTWO\nthree\n');
  utimesSync(join(main, 'a.txt'), then, then);
  utimesSync(join(main, '.git', 'index'), then, then);

  const diff = await fullDiff(main, 'master');
  assert.match(diff.patch, / one\n-two\n\+TWO\n three/);
});

test('worktrees added at once in a repository each come, at the path asked for, one fetch after the other', async () => {
  const { root, main } = repo();
  git(root, 'init', '--quiet', '--bare', 'origin.git');
  git(main, 'remote', 'add', 'origin', join(root, 'origin.git'));
  git(main, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  git(join(root, 'origin.git'), 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const paths = ['one', 'two', 'three'].map((name) => join(root, 'worktrees', name, 'app'));
  const added = await Promise.all(['one', 'two', 'three'].map((name, i) => addWorktree(main, { branch: name, task: name, base: null, root: join(root, 'worktrees'), path: paths[i] })));
  assert.deepEqual(added, paths);
});

test('git wt lays out task folders, copies .worktreeinclude files and removes cleanly', async () => {
  const { root, main } = repo();
  git(main, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
  write(main, '.env', 'SECRET=1\n');
  write(main, '.worktreeinclude', '.env\n');

  const path = wt(main, 'add', 'feat/x', '--task', 'task-1');
  assert.equal(path, join(root, 'worktrees', 'task-1', 'app'));
  assert.equal(git(path, 'branch', '--show-current'), 'feat/x');
  assert.equal(readFileSync(join(path, '.env'), 'utf8'), 'SECRET=1\n');
  assert.equal(wt(main, 'add', 'feat/x', '--task', 'task-1'), path, 'adding again reuses the worktree');
  assert.throws(() => wt(main, 'add', 'other', '--path', path), /already exists on branch feat\/x/);

  write(path, 'new.txt', 'x\n');
  git(path, 'add', 'new.txt');
  git(path, 'commit', '-qm', 'one');
  write(path, 'new.txt', 'y\n');
  git(path, 'commit', '-qam', 'two');
  write(path, 'dirty.txt', 'x\n');
  assert.equal(await unpushedCommits(path), 2);
  assert.equal(await changedFiles(path), 1);

  wt(main, 'rm', path, '--force', '--delete-branch');
  assert.equal(existsSync(join(root, 'worktrees', 'task-1')), false, 'the empty task folder goes too');
  assert.equal(git(main, 'branch', '--list', 'feat/x'), '');
});

function withOrigin(defaultBranch: string) {
  const { root, main } = repo();
  const origin = join(root, 'origin.git');
  git(main, 'branch', '-m', defaultBranch);
  git(root, 'init', '-q', '--bare', '-b', defaultBranch, origin);
  git(main, 'remote', 'add', 'origin', origin);
  git(main, 'push', '-q', '-u', 'origin', defaultBranch);
  const other = join(root, 'other');
  git(root, 'clone', '-q', origin, other);
  const land = (branch: string) => {
    git(other, 'switch', '-qC', branch);
    write(other, `${branch}.txt`, 'x\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', branch);
    git(other, 'push', '-q', 'origin', branch);
    return git(other, 'rev-parse', 'HEAD');
  };
  return { root, main, origin, land };
}

test('a new worktree starts from what origin has now, whatever its default branch is called, not from the local one', () => {
  const { main, land } = withOrigin('trunk');
  const latest = land('trunk');
  write(main, 'local.txt', 'unpushed\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'unpushed');

  const path = wt(main, 'add', 'feat');

  assert.equal(git(path, 'rev-parse', 'HEAD'), latest);
  assert.equal(git(main, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'), 'origin/trunk', 'noted for later reads');
  assert.throws(() => git(path, 'rev-parse', '--verify', '--quiet', '@{upstream}'), 'a new branch tracks nothing until pushed');
});

test('origin renaming its default branch moves new worktrees to it, past a stale origin/HEAD and a local branch of the old name', () => {
  const { main, origin, land } = withOrigin('master');
  git(main, 'remote', 'set-head', 'origin', 'master');
  const latest = land('main');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  assert.equal(git(wt(main, 'add', 'feat'), 'rev-parse', 'HEAD'), latest);
});

test('a branch only origin has, pushed after the last fetch, is picked up and tracked', () => {
  const { main, land } = withOrigin('main');
  const latest = land('shared');

  const path = wt(main, 'add', 'shared');

  assert.equal(git(path, 'rev-parse', 'HEAD'), latest);
  assert.equal(git(path, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/shared');
});

test('a configured base starts from origin\'s latest copy, named with origin/ or without; one origin lacks is used as it is', () => {
  const { main, land } = withOrigin('main');
  const latest = land('develop');
  git(main, 'branch', 'local-only');

  assert.equal(git(wt(main, 'add', 'one', '--base', 'develop'), 'rev-parse', 'HEAD'), latest);
  assert.equal(git(wt(main, 'add', 'two', '--base', 'origin/develop'), 'rev-parse', 'HEAD'), latest);
  assert.equal(git(wt(main, 'add', 'three', '--base', 'local-only'), 'rev-parse', 'HEAD'), git(main, 'rev-parse', 'local-only'));
});

test('a worktree is refused rather than started from a stale state when origin cannot be reached, and leaves nothing behind', () => {
  const { root, main } = withOrigin('main');
  git(main, 'remote', 'set-url', 'origin', join(root, 'gone.git'));

  assert.throws(() => wt(main, 'add', 'feat'), /origin cannot be reached/);
  assert.equal(git(main, 'branch', '--list', 'feat'), '');
  assert.equal(existsSync(join(root, 'worktrees', 'feat')), false);
  assert.equal(git(wt(main, 'add', 'chosen', '--from', 'main'), 'rev-parse', 'HEAD'), git(main, 'rev-parse', 'main'), 'an explicit ref needs no origin');
});

test('with no origin a new worktree starts from the main checkout\'s branch, under any name', async () => {
  const { main } = repo();
  git(main, 'branch', '-m', 'trunk');

  assert.equal(git(wt(main, 'add', 'feat'), 'rev-parse', 'HEAD'), git(main, 'rev-parse', 'trunk'));
  assert.equal(await detectBase(main), 'trunk');
});

test('the detected base is origin\'s default branch, ahead of the branch the main checkout is on', async () => {
  const { main } = withOrigin('release-line');
  git(main, 'remote', 'set-head', 'origin', 'release-line');
  git(main, 'switch', '-qc', 'feature');

  assert.equal(await detectBase(main), 'origin/release-line');
});

test('a commit counts as unpushed until a remote has it, though another local branch does', async () => {
  const { main } = repo();
  git(main, 'switch', '-qc', 'feature');
  write(main, 'f.txt', 'x\n');
  git(main, 'add', 'f.txt');
  git(main, 'commit', '-qm', 'f');
  git(main, 'branch', 'backup');
  const pushed = await unpushedCommits(main);
  git(main, 'update-ref', 'refs/remotes/origin/feature', 'HEAD');
  assert.deepEqual([pushed, await unpushedCommits(main)], [2, 0]);
});

test('pull request links for Azure DevOps and GitHub remotes', () => {
  assert.equal(pullRequestUrlOf('git@ssh.dev.azure.com:v3/org/Proj/repo', 7), 'https://dev.azure.com/org/Proj/_git/repo/pullrequest/7');
  assert.equal(pullRequestUrlOf('https://org@dev.azure.com/org/Proj/_git/repo', 7), 'https://dev.azure.com/org/Proj/_git/repo/pullrequest/7');
  assert.equal(pullRequestUrlOf('git@github.com:owner/repo.git', 3), 'https://github.com/owner/repo/pull/3');
  assert.equal(pullRequestUrlOf('ssh://git@github.com:22/owner/repo.git', 3), 'https://github.com/owner/repo/pull/3');
  assert.equal(pullRequestUrlOf('https://gitlab.com/a/b.git', 3), null);
  assert.equal(pullRequestUrlOf('', 3), null);
});

const commit = (dir: string, file: string, content: string) => {
  write(dir, file, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', file);
};

test('the branch against its upstream: same, ahead, behind, and diverged after origin\'s history is rewritten', async () => {
  const { root, main } = repo();
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'master', origin);
  git(main, 'remote', 'add', 'origin', origin);
  git(main, 'push', '-q', '-u', 'origin', 'master');
  const now = { fetchEvery: 0 };

  git(main, 'switch', '-qc', 'feature');
  assert.equal(await upstreamOf(main, 'master', now), null, 'a branch with no upstream');
  commit(main, 'one.txt', '1\n');
  commit(main, 'two.txt', '2\n');
  git(main, 'push', '-q', '-u', 'origin', 'feature');
  assert.deepEqual(await upstreamOf(main, 'master', now), {
    upstream: 'origin/feature', state: 'same', ahead: 0, behind: 0, behindFiles: 0, branchFiles: null, fetchFailed: false,
  });

  commit(main, 'local.txt', 'not pushed\n');
  assert.deepEqual(await upstreamOf(main, 'master', now), {
    upstream: 'origin/feature', state: 'ahead', ahead: 1, behind: 0, behindFiles: 0, branchFiles: null, fetchFailed: false,
  });
  git(main, 'reset', '-q', '--hard', 'HEAD~1');

  const other = join(root, 'other');
  git(root, 'clone', '-q', '-b', 'feature', origin, other);
  commit(other, 'three.txt', '3\n');
  git(other, 'push', '-q');
  assert.deepEqual(await upstreamOf(main, 'master', now), {
    upstream: 'origin/feature', state: 'behind', ahead: 0, behind: 1, behindFiles: 1, branchFiles: null, fetchFailed: false,
  });

  git(other, 'reset', '-q', '--hard', 'origin/master');
  for (const file of ['one.txt', 'x.txt', 'y.txt', 'z.txt']) commit(other, file, `rewritten ${file}\n`);
  git(other, 'push', '-q', '--force');
  assert.deepEqual(await upstreamOf(main, 'master', now), {
    upstream: 'origin/feature', state: 'diverged', ahead: 2, behind: 4, behindFiles: 4, branchFiles: 4, fetchFailed: false,
  });

  commit(other, 'w.txt', 'w\n');
  git(other, 'push', '-q');
  assert.equal((await upstreamOf(main, 'master', now))!.behind, 5);
  commit(other, 'v.txt', 'v\n');
  git(other, 'push', '-q');
  assert.equal((await upstreamOf(main, 'master'))!.behind, 5, 'a call within the minute does not fetch again');

  git(main, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
  assert.equal((await upstreamOf(main, 'master', now))!.fetchFailed, true);
});
