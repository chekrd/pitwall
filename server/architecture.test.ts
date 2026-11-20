import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BROKEN_MODEL, RETRIES_MODEL, STANDING_MODEL } from '../scripts/mock/architectureModels.ts';
import {
  ARCHITECTURE_DIR, architectures, architectureView, compareModels, keepArchitecture, KeepRefused, layout, layoutsCached, modelRoots, readModel, restoreArchitecture,
  seedArchitecture, type LayoutedData,
} from './architecture.ts';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-architecture-test-')));

function checkout(root: string, files: Record<string, string> = {}) {
  mkdirSync(join(root, ARCHITECTURE_DIR), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, ARCHITECTURE_DIR, name), text);
  return root;
}

const modelFiles = (root: string) => Object.fromEntries(readdirSync(join(root, ARCHITECTURE_DIR)).toSorted().map((n) => [n, readFileSync(join(root, ARCHITECTURE_DIR, n), 'utf8')]));

function repo(path: string) {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, 'readme.txt'), 'x\n');
  git(path, 'add', '-A');
  git(path, 'commit', '-qm', 'init');
  return path;
}

test('a model is the regular .c4 files directly in .pitwall/architecture; other files, folders and symlinks are not part of it', async () => {
  const root = checkout(scratch(), STANDING_MODEL);
  writeFileSync(join(root, ARCHITECTURE_DIR, 'notes.md'), 'not a model file');
  mkdirSync(join(root, ARCHITECTURE_DIR, 'old'));
  writeFileSync(join(root, ARCHITECTURE_DIR, 'old', 'model.c4'), 'model {}');
  const outside = join(root, 'outside.c4');
  writeFileSync(outside, 'model { secret = system }');
  symlinkSync(outside, join(root, ARCHITECTURE_DIR, 'linked.c4'));
  const model = await readModel(root);
  assert.deepEqual(model?.files.map((f) => f.name), ['model.c4', 'spec.c4', 'views.c4']);
  assert.equal((await readModel(checkout(scratch(), STANDING_MODEL)))?.stamp, model?.stamp, 'the same files make the same stamp');
  assert.equal(await readModel(scratch()), null);
  assert.equal(await readModel(checkout(scratch())), null, 'an empty folder is no model');

  const linked = scratch();
  mkdirSync(join(linked, '.pitwall'));
  symlinkSync(join(root, ARCHITECTURE_DIR), join(linked, ARCHITECTURE_DIR));
  assert.equal(await readModel(linked), null, 'a folder that is a symlink is not read');
});

test('a task\'s models: its worktree with the main checkout of its repository, or each worktree a task across a folder of repos opened', () => {
  const repos = [
    { id: 1, name: 'web', path: '/me/code/web', worktrees: [{ path: '/me/code/web', isMain: true }, { path: '/me/code/worktrees/fix/web', isMain: false }, { path: '/me/code/worktrees/both/web', isMain: false }] },
    { id: 2, name: 'api', path: '/me/code/api', worktrees: [{ path: '/me/code/api', isMain: true }, { path: '/me/code/worktrees/both/api', isMain: false }] },
  ];
  assert.deepEqual(modelRoots({ repoId: 1, worktree: '/me/code/worktrees/fix/web' }, repos), [{ key: '', name: 'web', root: '/me/code/worktrees/fix/web', main: '/me/code/web' }]);
  assert.deepEqual(modelRoots({ repoId: 1, worktree: '/me/code/web' }, repos), [{ key: '', name: 'web', root: '/me/code/web', main: '/me/code/web' }]);
  assert.deepEqual(modelRoots({ repoId: null, worktree: '/me/code/worktrees/both' }, repos), [
    { key: 'web', name: 'web', root: '/me/code/worktrees/both/web', main: '/me/code/web' },
    { key: 'api', name: 'api', root: '/me/code/worktrees/both/api', main: '/me/code/api' },
  ]);
  assert.deepEqual(modelRoots({ repoId: 9, worktree: '/me/gone' }, repos), [{ key: '', name: 'gone', root: '/me/gone', main: null }]);
});

test('the summary of each task is made without LikeC4, reads a file again only when its time or size changed, and says when the standing model differs', async () => {
  const base = scratch();
  const main = checkout(join(base, 'main'), STANDING_MODEL);
  const task = checkout(join(base, 'task'), STANDING_MODEL);
  const file = join(task, ARCHITECTURE_DIR, 'model.c4');
  const at = new Date(2026, 0, 1);
  utimesSync(file, at, at);
  const store = architectures();
  const tasks = [{ id: 't', models: [{ key: '', name: 'billing', root: task, main }] }, { id: 'none', models: [{ key: '', name: 'x', root: join(base, 'nothing'), main: null }] }];
  assert.equal(await store.refresh(tasks), true);
  const first = store.of('t')!.models[0];
  assert.deepEqual({ ...first, stamp: 's' }, { key: '', name: 'billing', stamp: 's', files: 3, standing: first.stamp, main: false });
  assert.equal(store.of('none'), null);
  assert.equal(await store.refresh(tasks), false, 'nothing changed');

  writeFileSync(file, STANDING_MODEL['model.c4'].replace('Customer', 'Customor'));
  utimesSync(file, at, at);
  assert.equal(await store.refresh(tasks), false, 'a file of the same time and size is not read again');
  utimesSync(file, new Date(at.getTime() + 5000), new Date(at.getTime() + 5000));
  assert.equal(await store.refresh(tasks), true);
  assert.notEqual(store.of('t')!.models[0].stamp, store.of('t')!.models[0].standing);

  rmSync(join(task, ARCHITECTURE_DIR), { recursive: true });
  assert.equal(await store.refresh(tasks), true);
  assert.equal(store.of('t'), null);
  assert.equal(await store.refresh([]), false);
});

test('a model is laid out once for its content: the same files in another checkout reuse the layout, a change lays it out again', async () => {
  const base = scratch();
  const a = await readModel(checkout(join(base, 'a'), RETRIES_MODEL));
  const b = await readModel(checkout(join(base, 'b'), RETRIES_MODEL));
  const cached = layoutsCached();
  const first = layout(a!);
  assert.equal(layout(b!), first, 'the same stamp is the same layout');
  assert.equal(layoutsCached(), cached + 1);
  const { data, errors } = await first;
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(data!.views), ['index', 'billing', 'api']);
  assert.ok(!JSON.stringify(data).includes(base) && !JSON.stringify(data).includes(tmpdir()), 'no path of the checkout or the copy LikeC4 read');
  assert.deepEqual((data!.elements['billing.api'] as { links?: unknown }).links, [{ url: '../../src/api', title: 'Source', relative: 'src/api' }], 'a link resolves from the checkout');

  const c = await readModel(checkout(join(base, 'c'), { ...RETRIES_MODEL, 'extra.c4': 'model {\n  bank = system \'Bank\'\n}\n' }));
  assert.notEqual(layout(c!), first);
  assert.ok((await layout(c!)).data!.elements.bank);
});

test('a model that does not parse lays out to its errors, with file, line, column and a short message', async () => {
  const view = await architectureView({ key: '', name: 'billing', root: checkout(scratch(), BROKEN_MODEL), main: null });
  assert.equal(view?.model, null);
  assert.deepEqual(view?.errors, [{ file: '.pitwall/architecture/model.c4', line: 54, column: 2, message: 'Missing \'}\' before the end of the file' }]);
  const typo = await architectureView({ key: '', name: 'billing', root: checkout(scratch(), { 'spec.c4': STANDING_MODEL['spec.c4'], 'model.c4': 'model {\n  a = system \'A\'\n  a -> \n}\n' }), main: null });
  assert.deepEqual(typo?.errors.map((e) => [e.file, e.line, e.message]), [['.pitwall/architecture/model.c4', 3, 'Target not resolved'], ['.pitwall/architecture/model.c4', 4, 'Unexpected \'}\'']]);
});

const data = (elements: Record<string, object>, relations: Record<string, object>) => ({ elements, relations, views: {} }) as unknown as LayoutedData;

test('the comparison names elements added, removed and changed by id, and relationships by source, target, kind and title', () => {
  const standing = data({
    a: { id: 'a', kind: 'system', title: 'A' },
    'a.b': { id: 'a.b', kind: 'container', title: 'B', technology: 'Go' },
    gone: { id: 'gone', kind: 'system', title: 'Gone' },
  }, {
    r1: { id: 'r1', source: { model: 'a.b' }, target: { model: 'gone' }, title: 'calls' },
    r2: { id: 'r2', source: { model: 'a' }, target: { model: 'a.b' }, title: 'uses', technology: 'HTTP' },
    r3: { id: 'r3', source: { model: 'a' }, target: { model: 'a.b' }, kind: 'async', title: 'uses' },
  });
  const task = data({
    a: { id: 'a', kind: 'system', title: 'A' },
    'a.b': { id: 'a.b', kind: 'container', title: 'B', technology: 'Rust' },
    'a.c': { id: 'a.c', kind: 'container', title: 'C' },
  }, {
    x: { id: 'x', source: { model: 'a' }, target: { model: 'a.b' }, title: 'uses', technology: 'gRPC' },
    y: { id: 'y', source: { model: 'a' }, target: { model: 'a.b' }, kind: 'async', title: 'uses' },
    z: { id: 'z', source: { model: 'a.b' }, target: { model: 'a.c' }, title: 'calls' },
  });
  const changes = compareModels(task, standing);
  assert.deepEqual(changes.elements, {
    added: [{ id: 'a.c', title: 'C', kind: 'container' }],
    removed: [{ id: 'gone', title: 'Gone', kind: 'system' }],
    changed: [{ id: 'a.b', title: 'B', kind: 'container', fields: ['technology'] }],
  });
  assert.deepEqual(changes.relations, {
    added: [{ key: 'a.b -> a.c "calls"', relation: 'z', source: 'a.b', target: 'a.c', sourceTitle: 'B', targetTitle: 'C', title: 'calls' }],
    removed: [{ key: 'a.b -> gone "calls"', relation: null, source: 'a.b', target: 'gone', sourceTitle: 'B', targetTitle: 'Gone', title: 'calls' }],
    changed: [{ key: 'a -> a.b "uses"', relation: 'x', source: 'a', target: 'a.b', sourceTitle: 'A', targetTitle: 'B', title: 'uses', fields: ['technology'] }],
  });
  const same = compareModels(standing, standing);
  assert.deepEqual([...Object.values(same.elements), ...Object.values(same.relations)].flat(), []);
});

test('the view of a task\'s model compares it with the standing one: a whole model added when the main checkout has none, nothing in the main checkout itself', async () => {
  const base = scratch();
  const main = checkout(join(base, 'main'), STANDING_MODEL);
  const task = checkout(join(base, 'task'), RETRIES_MODEL);
  const view = await architectureView({ key: '', name: 'billing', root: task, main });
  assert.equal(view?.main, false);
  assert.equal(view?.mainCheckout, main);
  assert.deepEqual(view?.changes?.elements.added.map((e) => e.id), ['billing.api.retries']);
  assert.deepEqual(view?.changes?.elements.changed.map((e) => [e.id, e.fields]), [['billing.api.webhooks', ['description']]]);
  assert.deepEqual(view?.changes?.relations.removed.map((r) => r.title), ['reports paid invoices']);
  assert.equal(view?.standing?.errors, 0);

  const alone = await architectureView({ key: '', name: 'billing', root: task, main: join(base, 'empty') });
  assert.equal(alone?.standing, null);
  assert.equal(alone?.changes?.elements.added.length, Object.keys(alone?.model?.elements ?? {}).length);

  const own = await architectureView({ key: '', name: 'billing', root: main, main });
  assert.equal(own?.main, true);
  assert.equal(own?.changes, null);
  assert.equal(own?.standing?.stamp, own?.stamp);
  assert.equal(await architectureView({ key: '', name: 'billing', root: join(base, 'none'), main }), null);
});

test('a new worktree starts with a copy of the main checkout\'s model, and the repository ignores .pitwall/; a worktree with a model of its own keeps it', async () => {
  const main = repo(join(scratch(), 'billing'));
  checkout(main, STANDING_MODEL);
  const worktree = join(main, '..', 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'task', worktree);
  assert.equal(await seedArchitecture(main, worktree), true);
  assert.deepEqual(modelFiles(worktree), STANDING_MODEL);
  assert.match(readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8'), /^\.pitwall\/$/m);
  assert.equal(git(worktree, 'status', '--porcelain'), '', 'the copy is not a change in git');

  writeFileSync(join(worktree, ARCHITECTURE_DIR, 'model.c4'), RETRIES_MODEL['model.c4']);
  assert.equal(await seedArchitecture(main, worktree), false, 'an existing worktree keeps its own model');
  assert.equal(readFileSync(join(worktree, ARCHITECTURE_DIR, 'model.c4'), 'utf8'), RETRIES_MODEL['model.c4']);
  assert.equal(await seedArchitecture(join(main, '..', 'nowhere'), worktree), false);
  const bare = join(main, '..', 'bare');
  mkdirSync(bare);
  assert.equal(await seedArchitecture(join(main, '..', 'no-model'), bare), false);
  assert.equal(existsSync(join(bare, '.pitwall')), false, 'nothing made without a model to copy');
});

test('Keep copies the task\'s .c4 files over the main checkout\'s, only for the model the page showed and one without errors; Undo puts the earlier ones back', async () => {
  const base = scratch();
  const main = checkout(join(base, 'main'), { ...STANDING_MODEL, 'old.c4': 'model {\n  old = system \'Old\'\n}\n' });
  writeFileSync(join(main, ARCHITECTURE_DIR, 'readme.md'), 'kept');
  const task = checkout(join(base, 'task'), RETRIES_MODEL);
  const model = { key: '', name: 'billing', root: task, main };
  const before = modelFiles(main);
  const { stamp } = (await readModel(task))!;

  await assert.rejects(keepArchitecture(model, 'stale'), (err: Error) => err instanceof KeepRefused && /changed since/.test(err.message));
  await assert.rejects(keepArchitecture({ ...model, root: main }, stamp), /holds the project's architecture already/);
  const { undo, files } = await keepArchitecture(model, stamp);
  assert.equal(files, 3);
  assert.deepEqual(modelFiles(main), { ...RETRIES_MODEL, 'readme.md': 'kept' }, 'the .c4 files replaced, a file of another kind left');
  assert.equal((await readModel(main))?.stamp, stamp);

  await restoreArchitecture(undo);
  assert.deepEqual(modelFiles(main), before);
  await assert.rejects(restoreArchitecture(undo), /too late/);

  const again = await keepArchitecture(model, stamp);
  writeFileSync(join(main, ARCHITECTURE_DIR, 'model.c4'), 'model {}\n');
  await assert.rejects(restoreArchitecture(again.undo), /changed since it was kept/);

  const broken = checkout(join(base, 'broken'), BROKEN_MODEL);
  await assert.rejects(keepArchitecture({ ...model, root: broken }, (await readModel(broken))!.stamp), /has errors/);

  const empty = join(base, 'fresh');
  mkdirSync(empty);
  const first = await keepArchitecture({ ...model, main: empty }, stamp);
  assert.deepEqual(modelFiles(empty), RETRIES_MODEL, 'a main checkout without a model gets one');
  await restoreArchitecture(first.undo);
  assert.deepEqual(modelFiles(empty), {});
});

test('Keep never writes outside the main checkout: not through a symlinked .pitwall or architecture folder, and a symlinked file is replaced, not followed', async () => {
  const base = scratch();
  const task = checkout(join(base, 'task'), RETRIES_MODEL);
  const { stamp } = (await readModel(task))!;
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(join(elsewhere, 'architecture'), { recursive: true });

  const linkedPitwall = join(base, 'main-a');
  mkdirSync(linkedPitwall);
  symlinkSync(elsewhere, join(linkedPitwall, '.pitwall'));
  await assert.rejects(keepArchitecture({ key: '', name: 'x', root: task, main: linkedPitwall }, stamp), /not a folder of its own/);

  const linkedFolder = join(base, 'main-b');
  mkdirSync(join(linkedFolder, '.pitwall'), { recursive: true });
  symlinkSync(join(elsewhere, 'architecture'), join(linkedFolder, ARCHITECTURE_DIR));
  await assert.rejects(keepArchitecture({ key: '', name: 'x', root: task, main: linkedFolder }, stamp), /not a folder of its own/);
  assert.deepEqual(readdirSync(join(elsewhere, 'architecture')), [], 'nothing written through either link');

  const linkedFile = checkout(join(base, 'main-c'));
  const target = join(elsewhere, 'target.c4');
  writeFileSync(target, 'outside\n');
  symlinkSync(target, join(linkedFile, ARCHITECTURE_DIR, 'model.c4'));
  await keepArchitecture({ key: '', name: 'x', root: task, main: linkedFile }, stamp);
  assert.equal(readFileSync(target, 'utf8'), 'outside\n', 'the file the link pointed at is untouched');
  assert.equal(lstatSync(join(linkedFile, ARCHITECTURE_DIR, 'model.c4')).isSymbolicLink(), false);
  assert.equal(readFileSync(join(linkedFile, ARCHITECTURE_DIR, 'model.c4'), 'utf8'), RETRIES_MODEL['model.c4']);
});
