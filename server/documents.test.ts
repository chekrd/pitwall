import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentFile, taskFolders, workflows } from './documents.ts';
import { excludeLocally } from './git.ts';

const QUESTIONS = '---\ntype: research-questions\nrepos: []\nflow: tdd\n---\n\n# Research Questions: Retries\n';
const OUTLINE = '---\ntype: structure-outline\nrepos: []\n---\n\n# Outline\n\n## Implementation Overview\n\n- [ ] Phase 1: Queue\n- [ ] Phase 2: Retry\n';

function checkout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-docs-')));
  const worktree = join(root, 'api');
  const task = join(worktree, '.pitwall', 'artifacts', 'webhook-retries');
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, '01-research-questions-retries.md'), QUESTIONS);
  writeFileSync(join(task, '02-tdd-retries.md'), '---\ntype: design-tdd\nrepos: []\n---\n\n# Retry worker\n\n![flow](diagram-flow.png)\n');
  writeFileSync(join(task, 'mockup-attempts.html'), '<!doctype html><p>attempts</p>');
  writeFileSync(join(task, 'diagram-flow.png'), 'png');
  writeFileSync(join(task, 'notes.txt'), 'not shown');
  writeFileSync(join(root, 'secret.txt'), 'outside');
  return { root, worktree, task };
}

test('a checkout\'s task folders list their documents in workflow order, with type, title and time, and the mockups and images beside them', async () => {
  const { worktree } = checkout();
  const [folder] = await taskFolders(worktree, [worktree]);
  assert.equal(folder.path, '.pitwall/artifacts/webhook-retries');
  assert.deepEqual(folder.documents.map((d) => [d.path, d.type, d.title, d.number]), [
    ['.pitwall/artifacts/webhook-retries/01-research-questions-retries.md', 'research-questions', 'Research Questions: Retries', 1],
    ['.pitwall/artifacts/webhook-retries/02-tdd-retries.md', 'tdd', 'Retry worker', 2],
  ]);
  assert.ok(folder.documents.every((d) => d.modifiedAt > 0));
  assert.deepEqual(folder.files.map((f) => [f.name, f.kind]), [['diagram-flow.png', 'image'], ['mockup-attempts.html', 'mockup']]);
  assert.deepEqual(await taskFolders(join(worktree, 'nowhere'), [join(worktree, 'nowhere')]), []);
});

test('a task across repos reads its task folder and its worktrees, each path from the task folder', async () => {
  const { root, worktree } = checkout();
  const own = join(root, '.pitwall', 'artifacts', 'spanning');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, '01-request-spanning.md'), '---\ntype: request\nrepos: []\n---\n# Original Request: spanning\n');
  const paths = (await taskFolders(root, [root, worktree])).map((f) => f.path);
  assert.deepEqual(paths, ['.pitwall/artifacts/spanning', 'api/.pitwall/artifacts/webhook-retries']);
});

test('a document route reads only inside .pitwall/artifacts: no traversal, no absolute path, no symlink out, not the folder itself', async () => {
  const { root, worktree, task } = checkout();
  const roots = [worktree];
  const inside = '.pitwall/artifacts/webhook-retries/02-tdd-retries.md';
  assert.equal(await documentFile(worktree, roots, inside), join(task, '02-tdd-retries.md'));
  for (const bad of [
    '.pitwall/artifacts/webhook-retries/../../../../secret.txt', '../secret.txt', `${root}/secret.txt`, '/etc/passwd',
    '.pitwall/artifacts/webhook-retries', '.pitwall/artifacts/./webhook-retries/02-tdd-retries.md', '.pitwall//artifacts/x.md',
    'package.json', '.pitwall/other/x.md', '.pitwall/artifacts/webhook-retries/missing.md', '.pitwall/artifacts/a\0b', '.pitwall\\artifacts\\x.md',
  ]) {
    assert.equal(await documentFile(worktree, roots, bad), null, bad);
  }
  symlinkSync(join(root, 'secret.txt'), join(task, 'leak.md'));
  assert.equal(await documentFile(worktree, roots, '.pitwall/artifacts/webhook-retries/leak.md'), null, 'a symlinked file leading out');
  symlinkSync(root, join(worktree, '.pitwall', 'artifacts', 'escape'));
  assert.equal(await documentFile(worktree, roots, '.pitwall/artifacts/escape/secret.txt'), null, 'a symlinked folder leading out');
  assert.deepEqual((await taskFolders(worktree, roots)).map((f) => f.name), ['webhook-retries'], 'nor are they listed');
  assert.ok(!(await taskFolders(worktree, roots))[0].documents.some((d) => d.name === 'leak.md'));

  const other = realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-docs-')));
  mkdirSync(join(other, 'artifacts', 't'), { recursive: true });
  writeFileSync(join(other, 'artifacts', 't', '01-request-x.md'), '# x');
  const moved = join(root, 'web');
  mkdirSync(moved);
  symlinkSync(other, join(moved, '.pitwall'));
  assert.equal(await documentFile(moved, [moved], '.pitwall/artifacts/t/01-request-x.md'), null, 'a .pitwall that is a symlink out of the checkout');
  assert.deepEqual(await taskFolders(moved, [moved]), []);
  assert.equal(await documentFile(root, [worktree], `api/${inside}`), join(task, '02-tdd-retries.md'), 'from a task folder, into one of its worktrees');
});

test('the summaries change only when a document does, read again only when its mtime or size changed, and go with their task', async () => {
  const { worktree, task } = checkout();
  // A clock that stands still, so no document settles into a version while the summaries are compared.
  const store = workflows({ now: () => 0 });
  const tasks = [{ id: 't1', base: worktree, roots: [worktree] }];
  assert.equal(await store.refresh(tasks), true);
  const first = store.of('t1')!;
  assert.deepEqual([first.flow, first.current], ['tdd', 'tdd']);
  assert.equal(await store.refresh(tasks), false, 'nothing changed');

  const outline = join(task, '03-structure-outline-retries.md');
  writeFileSync(outline, OUTLINE);
  assert.equal(await store.refresh(tasks), true);
  assert.equal(store.of('t1')!.current, 'outline');
  assert.notEqual(store.of('t1')!.stamp, first.stamp);

  const at = new Date(Date.now() + 5000);
  writeFileSync(outline, OUTLINE.replace('- [ ] Phase 1', '- [x] Phase 1'));
  utimesSync(outline, at, at);
  assert.equal(await store.refresh(tasks), true);
  assert.deepEqual([store.of('t1')!.current, store.of('t1')!.outline], ['implement', { done: 1, total: 2, unit: 'phase' }]);

  rmSync(join(worktree, '.pitwall'), { recursive: true });
  assert.equal(await store.refresh(tasks), true);
  assert.equal(store.of('t1'), null);
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, '01-research-questions-retries.md'), QUESTIONS);
  await store.refresh(tasks);
  assert.ok(store.of('t1'));
  assert.equal(await store.refresh([]), true);
  assert.equal(store.of('t1'), null, 'a task that is gone');
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

test(".pitwall/ goes once into the repository's own exclude file, which its worktrees share, made when missing", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-exclude-')));
  const main = join(root, 'app');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', join(root, 'feature'));
  const exclude = join(main, '.git', 'info', 'exclude');
  rmSync(join(main, '.git', 'info'), { recursive: true, force: true });

  await excludeLocally(join(root, 'feature'), '.pitwall/');
  assert.equal(readFileSync(exclude, 'utf8'), '.pitwall/\n');
  await Promise.all([excludeLocally(main, '.pitwall/'), excludeLocally(join(root, 'feature'), '.pitwall/')]);
  assert.equal(readFileSync(exclude, 'utf8'), '.pitwall/\n', 'once');

  writeFileSync(exclude, '# mine\n*.swp');
  await excludeLocally(main, '.pitwall/');
  assert.equal(readFileSync(exclude, 'utf8'), '# mine\n*.swp\n.pitwall/\n', 'kept, on a line of its own');

  mkdirSync(join(root, 'feature', '.pitwall', 'artifacts', 'x'), { recursive: true });
  writeFileSync(join(root, 'feature', '.pitwall', 'artifacts', 'x', '01-request-x.md'), '# x');
  assert.equal(git(join(root, 'feature'), 'status', '--porcelain', '--untracked-files=all'), '', 'git no longer sees the documents');
  assert.equal(existsSync(join(main, '.gitignore')), false, 'and .gitignore is never touched');
});
