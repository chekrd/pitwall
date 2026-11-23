import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BROKEN_MODEL, REGENERATED_MODEL, RETRIES_MODEL, STANDING_MODEL } from '../scripts/mock/architectureModels.ts';
import { ARCHITECTURE_DIR, readModel, type ModelRoot } from './architecture.ts';
import { regenerating, regenerationPrompt, RegenerateRefused, skillText, type RegenerateRun } from './regenerate.ts';

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-regenerate-test-')));

function checkout(root: string, files?: Record<string, string>) {
  mkdirSync(root, { recursive: true });
  if (!files) return root;
  mkdirSync(join(root, ARCHITECTURE_DIR), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, ARCHITECTURE_DIR, name), text);
  return root;
}

const writeModel = (root: string, files: Record<string, string>) => void checkout(root, files);

async function until(what: string, fn: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`never: ${what}`);
}

// Two repositories, each with worktrees: billing's main checkout has the standing model, one worktree an untouched
// copy of it, one a task's change, one none.
function setup(o: { run?: (r: RegenerateRun, release: Promise<void>) => Promise<void> } = {}) {
  const dir = scratch();
  const billing = checkout(join(dir, 'billing'), STANDING_MODEL);
  const web = checkout(join(dir, 'web'));
  const copy = checkout(join(dir, 'wt', 'copy', 'billing'), STANDING_MODEL);
  const changed = checkout(join(dir, 'wt', 'task', 'billing'), RETRIES_MODEL);
  const bare = checkout(join(dir, 'wt', 'bare', 'billing'));
  const webTask = checkout(join(dir, 'wt', 'task', 'web'));
  const roots: Record<string, ModelRoot[]> = {
    single: [{ key: '', name: 'billing', root: changed, main: billing }],
    folder: [{ key: 'billing', name: 'billing', root: changed, main: billing }, { key: 'web', name: 'web', root: webTask, main: web }],
    orphan: [{ key: '', name: 'lost', root: join(dir, 'lost'), main: null }],
  };
  const runs: RegenerateRun[] = [];
  let changes = 0;
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const r = regenerating({
    roots: (id) => roots[id] ?? [],
    checkout: (main) => ({ base: main === billing ? 'origin/develop' : 'origin/main', worktrees: main === billing ? [copy, changed, bare] : [webTask] }),
    logFile: (id, repo) => join(dir, 'sessions', id, 'architecture', `${repo}.log`),
    prompt: (repo) => regenerationPrompt(repo, 'SKILL'),
    run: async (run) => {
      runs.push(run);
      if (o.run) return o.run(run, released);
      await released;
      run.log('{"type":"assistant"}');
      writeModel(run.cwd, REGENERATED_MODEL);
    },
    changed: () => void changes++,
  });
  return { r, dir, billing, web, copy, changed, bare, webTask, runs, release, changes: () => changes };
}

test('a task\'s repositories are the ones with a main checkout: its own, or each worktree a folder task opened', () => {
  const t = setup();
  assert.deepEqual(t.r.of('single'), { repos: [{ key: '', name: 'billing', main: t.billing }], running: [], failed: [] });
  assert.deepEqual(t.r.of('folder')?.repos.map((x) => x.name), ['billing', 'web']);
  assert.equal(t.r.of('orphan'), null, 'nothing to regenerate without a main checkout');
  assert.equal(t.r.of('unknown'), null);
  assert.throws(() => t.r.start('orphan', ['']), RegenerateRefused);
  assert.throws(() => t.r.start('folder', ['docs']), /no repository docs/);
  assert.equal(t.runs.length, 0);
});

test('a run per picked repository writes in its main checkout on the prompt that says whose architecture it is', async () => {
  const t = setup();
  const done = t.r.start('folder', ['web', 'billing', 'web']);
  assert.deepEqual(t.r.of('folder')?.running, ['billing', 'web']);
  await until('both runs started', () => t.runs.length === 2);
  assert.deepEqual(t.runs.map((x) => x.cwd).toSorted(), [t.billing, t.web]);
  const prompt = t.runs.find((x) => x.cwd === t.billing)!.prompt;
  assert.match(prompt, /Regenerate the architecture model of the repository billing in this checkout, [^\n]+billing, which is its main checkout\./);
  assert.match(prompt, /the repository's own architecture as on origin\/develop, not a task's/);
  assert.match(prompt, /index view's title or description says that this is billing's architecture as on origin\/develop/);
  assert.match(prompt, /write only under \.pitwall\/architecture\/ and run the check/);
  assert.match(prompt, /SKILL$/);
  t.release();
  await done;
  assert.deepEqual(t.r.of('folder'), { ...t.r.of('folder')!, running: [], failed: [] });
  assert.equal((await readModel(t.billing))?.files.find((f) => f.name === 'model.c4')?.text, REGENERATED_MODEL['model.c4']);
});

test('a second run for a main checkout already being regenerated is refused, from any task, and nothing more starts', async () => {
  const t = setup();
  const done = t.r.start('single', ['']);
  assert.throws(() => t.r.start('folder', ['web', 'billing']), /billing's architecture is being regenerated already/);
  assert.throws(() => t.r.start('single', ['']), RegenerateRefused);
  assert.deepEqual(t.r.of('folder')?.running, [], 'the refused one marks nothing');
  t.release();
  await done;
  const again = t.r.start('folder', ['billing']);
  await again;
  assert.equal(t.runs.length, 2);
});

test('once it succeeds, a worktree with an untouched copy or none gets the new model; one with a task\'s changes keeps them', async () => {
  const t = setup();
  t.release();
  await t.r.start('single', ['']);
  const stamp = async (root: string) => (await readModel(root))?.stamp ?? null;
  const fresh = await stamp(t.billing);
  assert.equal(await stamp(t.copy), fresh);
  assert.equal(await stamp(t.bare), fresh);
  assert.equal((await readModel(t.changed))?.files.find((f) => f.name === 'model.c4')?.text, RETRIES_MODEL['model.c4']);
  const log = readFileSync(join(t.dir, 'sessions', 'single', 'architecture', 'billing.log'), 'utf8');
  assert.match(log, /^Regenerating billing's architecture in /);
  assert.match(log, /\{"type":"assistant"\}\n/);
  assert.match(log, /Done\. Worktrees given the new model: .*copy\/billing, .*bare\/billing\n$/);
  assert.ok(t.changes() >= 2, 'the board hears of the start and the end');
});

test('a run that fails, or leaves a model that does not parse, marks the repository failed with its log until the next run', async () => {
  let mode: 'fail' | 'broken' | 'ok' = 'fail';
  const t = setup({
    run: async (run) => {
      run.log('working');
      if (mode === 'fail') throw new Error('claude -p exited 1: out of credits');
      writeModel(run.cwd, mode === 'broken' ? BROKEN_MODEL : REGENERATED_MODEL);
    },
  });
  const before = (await readModel(t.copy))?.stamp;
  await t.r.start('single', ['']);
  const log = join(t.dir, 'sessions', 'single', 'architecture', 'billing.log');
  assert.deepEqual(t.r.of('single'), { repos: [{ key: '', name: 'billing', main: t.billing }], running: [], failed: [{ key: '', log }] });
  assert.match(readFileSync(log, 'utf8'), /working\nFailed: claude -p exited 1: out of credits\n$/);
  assert.equal((await readModel(t.copy))?.stamp, before, 'no copy changes after a failure');

  mode = 'broken';
  const next = t.r.start('single', ['']);
  assert.deepEqual(t.r.of('single')?.failed, [], 'a new run clears the mark');
  await next;
  assert.deepEqual(t.r.of('single')?.failed, [{ key: '', log }]);
  assert.match(readFileSync(log, 'utf8'), /Failed: the model has errors:\n\.pitwall\/architecture\/model\.c4:\d+:\d+ /);
  assert.equal((await readModel(t.copy))?.stamp, before);

  mode = 'ok';
  await t.r.start('single', ['']);
  assert.deepEqual(t.r.of('single')?.failed, []);
});

test('the skill goes into the prompt as connect installs it, without its front matter', () => {
  assert.equal(skillText('---\nname: architecture\ndescription: x\n---\n\nKeep it.\n\n    node {{PITWALL}}/scripts/architecture.ts check\n', '/Users/me/pitwall'),
    'Keep it.\n\n    node /Users/me/pitwall/scripts/architecture.ts check');
});

test('the real run refuses what its allowed tools do not name: the list alone limits nothing under the user\'s own permission mode', async () => {
  const { REGENERATE_ARGS } = await import('./sessions.ts');
  assert.equal(REGENERATE_ARGS[REGENERATE_ARGS.indexOf('--permission-mode') + 1], 'dontAsk');
  const allowed = REGENERATE_ARGS.slice(REGENERATE_ARGS.indexOf('--allowedTools') + 1);
  assert.deepEqual(allowed.filter((t) => /^(Write|Edit|Bash)/.test(t)).map((t) => t.replace(/\(.*/, '')), ['Write', 'Edit', 'Bash']);
  assert.ok(allowed.every((t) => !/^(Write|Edit|Bash)$/.test(t)));
  assert.ok(allowed.includes('Write(.pitwall/architecture/**)') && allowed.includes('Edit(.pitwall/architecture/**)'));
});
