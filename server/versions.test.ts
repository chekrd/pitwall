import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { workflows } from './documents.ts';
import { currentVersion } from './rpi.ts';

const DOC = '.pitwall/artifacts/retries/01-research-questions-retries.md';
const text = (n: number) => `---\ntype: research-questions\nrepos: []\n---\n\n# Research Questions: Retries\n\n${'More. '.repeat(n)}\n`;

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-versions-')));
  const worktree = join(root, 'api');
  mkdirSync(join(worktree, '.pitwall', 'artifacts', 'retries'), { recursive: true });
  const file = join(worktree, DOC);
  const state = join(root, 'state');
  let clock = 1_000;
  const store = workflows({ versionsDir: (task) => join(state, task), settleMs: 2000, now: () => clock });
  const tasks = (working = false) => [{ id: 't1', base: worktree, roots: [worktree], working }];
  // Each write moves the file's time on, as the passes read again only a document whose time or size changed.
  let mtime = Date.now() / 1000;
  const write = (body: string) => {
    writeFileSync(file, body);
    mtime += 10;
    utimesSync(file, mtime, mtime);
  };
  return {
    store, state, file, write, tasks,
    at: (ms: number) => {
      clock = ms;
    },
    version: () => store.of('t1')?.versions?.[DOC] ?? null,
  };
}

test('a document becomes a version once its text has stood unchanged a while, and a touch or the same text again makes none', async () => {
  const t = setup();
  t.write(text(1));
  assert.equal(await t.store.refresh(t.tasks()), true);
  assert.deepEqual(t.version(), { latest: 0, settled: false }, 'not yet: it has only just been seen');
  assert.equal(currentVersion(t.version()), 1, 'it reads as the version it is about to become');
  t.at(2_000);
  assert.equal(await t.store.refresh(t.tasks()), false);
  t.at(3_000);
  assert.equal(await t.store.refresh(t.tasks()), true);
  assert.deepEqual(t.version(), { latest: 1, settled: true });

  utimesSync(t.file, Date.now() / 1000 + 100, Date.now() / 1000 + 100);
  t.at(10_000);
  await t.store.refresh(t.tasks());
  assert.deepEqual(t.version(), { latest: 1, settled: true }, 'a touch makes no version');
  t.write(text(1));
  t.at(20_000);
  await t.store.refresh(t.tasks());
  t.at(30_000);
  await t.store.refresh(t.tasks());
  assert.deepEqual(t.version(), { latest: 1, settled: true }, 'nor the same text written again');
  assert.deepEqual((await t.store.versions.list('t1', DOC)).map((v) => v.n), [1]);
  assert.equal(await t.store.versions.text('t1', DOC, 1), text(1));
  assert.equal(await t.store.versions.text('t1', DOC, 2), null);
});

test('quick successive writes settle on one version, and a turn under way holds it back until it ends', async () => {
  const t = setup();
  t.write(text(1));
  await t.store.refresh(t.tasks());
  t.at(4_000);
  await t.store.refresh(t.tasks());
  assert.equal(t.version()?.latest, 1);

  for (const [i, ms] of [5_000, 5_500, 6_200, 7_000].entries()) {
    t.at(ms);
    t.write(text(i + 2));
    await t.store.refresh(t.tasks());
  }
  assert.deepEqual(t.version(), { latest: 1, settled: false });
  t.at(30_000);
  await t.store.refresh(t.tasks(true));
  assert.deepEqual(t.version(), { latest: 1, settled: false }, 'held while Claude works');
  await t.store.refresh(t.tasks(false));
  assert.deepEqual(t.version(), { latest: 2, settled: true }, 'cut when the turn has ended');
  assert.equal(await t.store.versions.text('t1', DOC, 2), text(5), 'the text it settled on');
  assert.deepEqual((await t.store.versions.list('t1', DOC)).map((v) => v.n), [1, 2]);
});

test('versions outlive a restart of the board, live in the state folder, never the worktree, and go with the task', async () => {
  const t = setup();
  t.write(text(1));
  await t.store.refresh(t.tasks());
  t.at(5_000);
  await t.store.refresh(t.tasks());
  const again = workflows({ versionsDir: (task) => join(t.state, task), now: () => 6_000 });
  await again.refresh(t.tasks());
  assert.deepEqual(again.of('t1')?.versions?.[DOC], { latest: 1, settled: true }, 'read back from disk, not cut again');
  assert.ok(existsSync(join(t.state, 't1')));
  assert.deepEqual(readdirSync(join(t.file, '..')), ['01-research-questions-retries.md'], 'nothing beside the document');

  await again.refresh([]);
  rmSync(join(t.state, 't1'), { recursive: true });
  assert.deepEqual(await again.versions.list('t1', DOC), [], 'gone with the task folder');
});

test('the mock can record a history at once, and many versions are all kept', async () => {
  const t = setup();
  for (let i = 1; i <= 25; i++) await t.store.versions.record('t1', DOC, text(i), i);
  await t.store.versions.record('t1', DOC, text(25), 99);
  assert.equal((await t.store.versions.list('t1', DOC)).length, 25, 'no cap, and the same text twice is one version');
  t.write(text(25));
  await t.store.refresh(t.tasks());
  assert.deepEqual(t.version(), { latest: 25, settled: true });
});
