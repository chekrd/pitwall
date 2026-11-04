import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readOnly } from './advisor.ts';
import { repos } from './db.ts';
import { makeTaskFolder, openWorktree } from './folderTasks.ts';
import { refreshWorkspace } from './workspace.ts';

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

test('the advisor may not edit the worktree of a task in one repository', () => {
  assert.deepEqual(readOnly({ repoId: 1, worktree: '/w/app' }), ['Edit(//w/app/**)', 'Write(//w/app/**)', 'NotebookEdit(//w/app/**)']);
});

test('the advisor of a task across a folder may edit neither the task folder, its worktrees nor the main checkouts', async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-folder-')));
  for (const name of ['web', 'api']) {
    const main = join(folder, name);
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'readme.txt'), `${name}\n`);
    git(main, 'add', '-A');
    git(main, 'commit', '-qm', 'init');
    repos.add(main);
  }
  await refreshWorkspace();
  const task = await makeTaskFolder(folder, 'cross');
  await openWorktree({ repo: 'api', task_folder: task });
  const rules = readOnly({ repoId: null, worktree: task });
  for (const dir of [task, join(task, 'api'), join(folder, 'web'), join(folder, 'api')]) {
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) assert.ok(rules.includes(`${tool}(/${dir}/**)`), `${tool} ${dir}`);
  }
  assert.equal(rules.length, 12);
});
