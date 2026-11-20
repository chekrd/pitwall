import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contentHash } from './versions.ts';

// A checkout's LikeC4 model of its architecture: the `.c4` files directly in `.pitwall/architecture/`, which git is
// told to ignore. The repository's main checkout holds the project's standing model; a task's worktree starts with a
// copy of it, which the task's Claude edits.

export const ARCHITECTURE_DIR = '.pitwall/architecture';
const MODEL_FILE = /^[^/\\\0]+\.c4$/;

export interface ModelFile {
  name: string;
  text: string;
}

// A model in one checkout of a task, `main` being its repository's main checkout (the checkout itself when the task
// runs there). `key` names it in the task: '' for the task's own worktree, the repository's folder for a task across
// a folder of repos.
export interface ModelRoot {
  key: string;
  name: string;
  root: string;
  main: string | null;
}

export interface ArchitectureModel {
  key: string;
  name: string;
  // The hash of the files' names and text; equal stamps are equal models.
  stamp: string;
  files: number;
  // The stamp of the main checkout's model, or null when it has none.
  standing: string | null;
  main: boolean;
}

export interface ArchitectureSummary {
  models: ArchitectureModel[];
}

export interface ModelError {
  // From the checkout, as `.pitwall/architecture/model.c4`.
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface ElementChange {
  id: string;
  title: string;
  kind: string;
  fields?: string[];
}

export interface RelationChange {
  // Source, target, kind and title, which name a relationship in LikeC4.
  key: string;
  // LikeC4's id of it in the task's model, for marking its edges; none for a removed one.
  relation: string | null;
  source: string;
  target: string;
  sourceTitle: string;
  targetTitle: string;
  title: string;
  fields?: string[];
}

export interface Changes<T> {
  added: T[];
  removed: T[];
  changed: T[];
}

export interface ArchitectureChanges {
  elements: Changes<ElementChange>;
  relations: Changes<RelationChange>;
}

export interface ArchitectureView {
  key: string;
  name: string;
  stamp: string;
  main: boolean;
  // The repository's main checkout, which holds the project's standing model.
  mainCheckout: string | null;
  // LikeC4's layouted model data (`LikeC4Model.create` takes it), null when the model has errors.
  model: LayoutedData | null;
  errors: ModelError[];
  standing: { stamp: string; errors: number } | null;
  // Against the standing model; null in the main checkout, or while either model has errors.
  changes: ArchitectureChanges | null;
}

// What the page reads of the layouted data; the rest goes to LikeC4 as it came.
export interface LayoutedData {
  elements: Record<string, ModelElement>;
  relations: Record<string, ModelRelation>;
  views: Record<string, { id: string; title?: string | null; viewOf?: string | null; nodes: unknown[]; edges: unknown[] }>;
}

interface ModelElement {
  id: string;
  kind: string;
  title: string;
  [field: string]: unknown;
}

interface ModelRelation {
  id: string;
  source: { model: string };
  target: { model: string };
  title?: string | null;
  kind?: string | null;
  [field: string]: unknown;
}

// The checkout's architecture folder, made when `create` and missing; null when `.pitwall` or `architecture` is
// anything but a folder of its own, a symlink included, so nothing read or written here lies outside the checkout.
async function ownFolder(root: string, create = false) {
  let dir = await realpath(root).catch(() => null);
  if (!dir) return null;
  for (const part of ARCHITECTURE_DIR.split('/')) {
    dir = join(dir, part);
    const st = await lstat(dir).catch(() => null);
    if (!st && create) await mkdir(dir);
    else if (!st?.isDirectory()) return null;
  }
  return dir;
}

// The regular `.c4` files directly in the folder, by name; a symlink is none of them.
async function filesIn(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile() && MODEL_FILE.test(e.name)).map((e) => e.name).toSorted();
}

const stampOf = (files: { name: string; hash: string }[]) => contentHash(files.map((f) => `${f.name}\0${f.hash}`).join('\n'));

export async function readModel(root: string): Promise<{ files: ModelFile[]; stamp: string } | null> {
  const dir = await ownFolder(root);
  if (!dir) return null;
  const files = (await Promise.all((await filesIn(dir)).map(async (name) => {
    const text = await readFile(join(dir, name), 'utf8').catch(() => null);
    return text === null ? null : { name, text };
  }))).filter((f) => f !== null);
  return files.length ? { files, stamp: stampOf(files.map((f) => ({ name: f.name, hash: contentHash(f.text) }))) } : null;
}

// Parse errors come with every token LikeC4 could have taken instead; the token it found says enough.
function shortMessage(message: string) {
  const found = /^Expecting: one of these possible Token sequences:[\s\S]*\bbut found: (.*)$/.exec(message);
  if (found) return `Unexpected ${found[1]}`;
  const ended = /^Expecting token of type (.+) but found ``\.$/.exec(message);
  return ended ? `Missing ${ended[1]} before the end of the file` : message.trim();
}

export interface Layout {
  data: LayoutedData | null;
  errors: ModelError[];
}

const LAYOUTS_KEPT = 24;
const layouts = new Map<string, Promise<Layout>>();
let turn: Promise<unknown> = Promise.resolve();
let loaded: Promise<typeof import('likec4')> | null = null;

// LikeC4 loads on the first layout, not at start. It reads a copy of the files in a folder of its own, so what it lays
// out is the text the stamp was made of, and the paths in its data are made relative to the checkout.
async function layoutFiles(files: ModelFile[]): Promise<Layout> {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-architecture-')));
  try {
    const dir = join(tmp, ARCHITECTURE_DIR);
    await mkdir(dir, { recursive: true });
    await Promise.all(files.map((f) => writeFile(join(dir, f.name), f.text)));
    loaded ??= import('likec4');
    const { LikeC4 } = await loaded;
    const likec4 = await LikeC4.fromWorkspace(dir, { printErrors: false, logger: false });
    try {
      const errors = likec4.getErrors().map((e) => ({
        file: `${ARCHITECTURE_DIR}/${basename(e.sourceFsPath)}`, line: e.line + 1, column: e.range.start.character + 1, message: shortMessage(e.message),
      })).toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
      if (errors.length) return { data: null, errors };
      const model = await likec4.layoutedModel();
      const json = JSON.stringify(model.$data).replaceAll(`${pathToFileURL(tmp).href}/`, '').replaceAll(`${tmp}/`, '');
      return { data: JSON.parse(json) as LayoutedData, errors: [] };
    } finally {
      await likec4.dispose();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// One layout at a time, each model once while it stays among the last few laid out.
export function layout(model: { files: ModelFile[]; stamp: string }): Promise<Layout> {
  const hit = layouts.get(model.stamp);
  if (hit) {
    layouts.delete(model.stamp);
    layouts.set(model.stamp, hit);
    return hit;
  }
  const next = turn.then(() => layoutFiles(model.files), () => layoutFiles(model.files));
  turn = next.catch(() => {});
  layouts.set(model.stamp, next);
  next.catch(() => layouts.delete(model.stamp));
  for (const stamp of layouts.keys()) {
    if (layouts.size <= LAYOUTS_KEPT) break;
    layouts.delete(stamp);
  }
  return next;
}

export const layoutsCached = () => layouts.size;

const ELEMENT_FIELDS = ['kind', 'title', 'technology', 'summary', 'description', 'tags', 'links', 'metadata', 'style'] as const;
const RELATION_FIELDS = ['technology', 'description', 'tags', 'links', 'metadata', 'navigateTo', 'color', 'line', 'head', 'tail'] as const;

const differing = (a: Record<string, unknown>, b: Record<string, unknown>, fields: readonly string[]) =>
  fields.filter((f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null));

const relationKey = (r: ModelRelation) => `${r.source.model} -> ${r.target.model}${r.kind ? ` [${r.kind}]` : ''}${r.title ? ` "${r.title}"` : ''}`;

// Relationships by their key, a second one with the same key counted as `key #2`.
function keyed(relations: Record<string, ModelRelation>) {
  const out = new Map<string, ModelRelation>();
  for (const r of Object.values(relations)) {
    const key = relationKey(r);
    let n = 1;
    while (out.has(n === 1 ? key : `${key} #${n}`)) n++;
    out.set(n === 1 ? key : `${key} #${n}`, r);
  }
  return out;
}

// What the task's model adds, removes and changes against the standing one: elements by id, relationships by source,
// target, kind and title.
export function compareModels(task: LayoutedData, standing: LayoutedData): ArchitectureChanges {
  const element = (e: ModelElement, fields?: string[]): ElementChange => ({ id: e.id, title: e.title, kind: e.kind, ...(fields && { fields }) });
  const elements: Changes<ElementChange> = { added: [], removed: [], changed: [] };
  for (const e of Object.values(task.elements)) {
    const before = standing.elements[e.id];
    if (!before) elements.added.push(element(e));
    else {
      const fields = differing(e, before, ELEMENT_FIELDS);
      if (fields.length) elements.changed.push(element(e, fields));
    }
  }
  for (const e of Object.values(standing.elements)) if (!task.elements[e.id]) elements.removed.push(element(e));

  const relation = (key: string, r: ModelRelation, own: boolean, fields?: string[]): RelationChange => {
    const { elements: by } = own ? task : standing;
    return {
      key, relation: own ? r.id : null, source: r.source.model, target: r.target.model,
      sourceTitle: by[r.source.model]?.title ?? r.source.model, targetTitle: by[r.target.model]?.title ?? r.target.model, title: r.title ?? '', ...(fields && { fields }),
    };
  };
  const relations: Changes<RelationChange> = { added: [], removed: [], changed: [] };
  const [now, then] = [keyed(task.relations), keyed(standing.relations)];
  for (const [key, r] of now) {
    const before = then.get(key);
    if (!before) relations.added.push(relation(key, r, true));
    else {
      const fields = differing(r, before, RELATION_FIELDS);
      if (fields.length) relations.changed.push(relation(key, r, true, fields));
    }
  }
  for (const [key, r] of then) if (!now.has(key)) relations.removed.push(relation(key, r, false));

  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
  for (const list of Object.values(elements)) list.sort(byId);
  for (const list of Object.values(relations)) list.sort(byKey);
  return { elements, relations };
}

export async function architectureView(m: ModelRoot): Promise<ArchitectureView | null> {
  const own = await readModel(m.root);
  if (!own) return null;
  const main = !m.main || m.main === m.root;
  const standingModel = main ? null : await readModel(m.main!);
  const [mine, theirs] = await Promise.all([layout(own), standingModel && layout(standingModel)]);
  return {
    key: m.key,
    name: m.name,
    stamp: own.stamp,
    main,
    mainCheckout: m.main,
    model: mine.data,
    errors: mine.errors,
    standing: main ? { stamp: own.stamp, errors: mine.errors.length } : standingModel && theirs ? { stamp: standingModel.stamp, errors: theirs.errors.length } : null,
    changes: main || !mine.data ? null : theirs ? (theirs.data ? compareModels(mine.data, theirs.data) : null) : compareModels(mine.data, { elements: {}, relations: {}, views: {} }),
  };
}

// Puts `files` in place of the folder's `.c4` files. A file is unlinked before it is written, so a symlink in its place
// is replaced rather than followed.
async function replaceFiles(dir: string, files: ModelFile[]) {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(entries.filter((e) => MODEL_FILE.test(e.name) && (e.isFile() || e.isSymbolicLink())).map((e) => unlink(join(dir, e.name))));
  for (const f of files) await writeFile(join(dir, f.name), f.text, { flag: 'wx' });
}

// git.ts resolves the login shell's environment as it loads, which `pnpm architecture` has no use for.
const ignorePitwall = (root: string) => import('./git.ts').then(({ excludeLocally }) => excludeLocally(root, '.pitwall/')).catch(() => {});

// A new worktree starts with the standing model, unless it has a model of its own already, as a worktree that existed does.
export async function seedArchitecture(main: string, worktree: string) {
  const model = await readModel(main);
  if (!model || (await readModel(worktree))) return false;
  const dir = await ownFolder(worktree, true);
  if (!dir) return false;
  await replaceFiles(dir, model.files);
  await ignorePitwall(worktree);
  return true;
}

export class KeepRefused extends Error {}

interface Backup {
  main: string;
  files: ModelFile[];
  // The stamp Keep left, which Undo expects to find.
  kept: string;
  at: number;
}

const UNDO_MS = 10 * 60_000;
const backups = new Map<string, Backup>();

// Makes the task's model the project's: its `.c4` files replace the main checkout's. `stamp` is the model the page
// showed, refused when the files changed since. Answers a token that undoes it.
export async function keepArchitecture(m: ModelRoot, stamp: string, now = Date.now()) {
  if (!m.main || m.main === m.root) throw new KeepRefused('this checkout holds the project\'s architecture already');
  const model = await readModel(m.root);
  if (!model) throw new KeepRefused('this task has no architecture model');
  if (model.stamp !== stamp) throw new KeepRefused('the task\'s model changed since the page showed it; look at it again');
  if ((await layout(model)).errors.length) throw new KeepRefused('the task\'s model has errors; it can be kept once it has none');
  const dir = await ownFolder(m.main, true);
  if (!dir) throw new KeepRefused(`${ARCHITECTURE_DIR} in ${m.main} is not a folder of its own`);
  const previous = (await readModel(m.main))?.files ?? [];
  await replaceFiles(dir, model.files);
  await ignorePitwall(m.main);
  for (const [token, b] of backups) if (now - b.at > UNDO_MS) backups.delete(token);
  const undo = randomUUID();
  backups.set(undo, { main: m.main, files: previous, kept: model.stamp, at: now });
  return { undo, files: model.files.length };
}

export async function restoreArchitecture(undo: string, now = Date.now()) {
  const b = backups.get(undo);
  if (!b || now - b.at > UNDO_MS) throw new KeepRefused('it is too late to undo that');
  if ((await readModel(b.main))?.stamp !== b.kept) throw new KeepRefused('the project\'s architecture changed since it was kept');
  const dir = await ownFolder(b.main);
  if (!dir) throw new KeepRefused(`${ARCHITECTURE_DIR} in ${b.main} is not a folder of its own`);
  await replaceFiles(dir, b.files);
  backups.delete(undo);
}

interface Repoish {
  name: string;
  path: string;
  worktrees: { path: string; isMain: boolean }[];
}

// Where a task's models are: its worktree, or each worktree a task across a folder of repos opened.
export function modelRoots(s: { repoId: number | null; worktree: string }, repos: (Repoish & { id: number })[]): ModelRoot[] {
  const mainOf = (r: Repoish) => r.worktrees.find((w) => w.isMain)?.path ?? r.path;
  if (s.repoId !== null) {
    const repo = repos.find((r) => r.id === s.repoId);
    return [{ key: '', name: repo?.name ?? basename(s.worktree), root: s.worktree, main: repo ? mainOf(repo) : null }];
  }
  return repos.flatMap((r) => r.worktrees.filter((w) => !w.isMain && dirname(w.path) === s.worktree)
    .map((w) => ({ key: basename(w.path), name: r.name, root: w.path, main: mainOf(r) })));
}

// Each task's summary, kept between syncs and made without LikeC4: a pass lists the folders and reads only the files
// whose time or size changed.
export function architectures() {
  const summaries = new Map<string, ArchitectureSummary>();
  const hashes = new Map<string, { mtimeMs: number; size: number; hash: string }>();
  const ignored = new Set<string>();

  async function stamp(root: string, touched: Set<string>) {
    const dir = await ownFolder(root);
    if (!dir) return null;
    const files = (await Promise.all((await filesIn(dir)).map(async (name) => {
      const file = join(dir, name);
      const st = await lstat(file).catch(() => null);
      if (!st?.isFile()) return null;
      touched.add(file);
      const hit = hashes.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { name, hash: hit.hash };
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text === null) return null;
      const read = { mtimeMs: st.mtimeMs, size: st.size, hash: contentHash(text) };
      hashes.set(file, read);
      return { name, hash: read.hash };
    }))).filter((f) => f !== null);
    if (!files.length) return null;
    if (!ignored.has(root)) {
      ignored.add(root);
      void ignorePitwall(root);
    }
    return { stamp: stampOf(files), files: files.length };
  }

  return {
    of: (id: string) => summaries.get(id) ?? null,
    // Answers whether any summary changed.
    async refresh(tasks: { id: string; models: ModelRoot[] }[]) {
      let changed = false;
      const touched = new Set<string>();
      const stamps = new Map<string, Promise<Awaited<ReturnType<typeof stamp>>>>();
      const stampAt = (root: string) => {
        if (!stamps.has(root)) stamps.set(root, stamp(root, touched).catch(() => null));
        return stamps.get(root)!;
      };
      await Promise.all(tasks.map(async (t) => {
        const models = (await Promise.all(t.models.map(async (m): Promise<ArchitectureModel | null> => {
          const own = await stampAt(m.root);
          if (!own) return null;
          const main = !m.main || m.main === m.root;
          const standing = main ? own.stamp : (await stampAt(m.main!))?.stamp ?? null;
          return { key: m.key, name: m.name, stamp: own.stamp, files: own.files, standing, main };
        }))).filter((m) => m !== null);
        const next = models.length ? { models } : null;
        if (JSON.stringify(next) === JSON.stringify(summaries.get(t.id) ?? null)) return;
        if (next) summaries.set(t.id, next);
        else summaries.delete(t.id);
        changed = true;
      }));
      const seen = new Set(tasks.map((t) => t.id));
      for (const id of summaries.keys()) {
        if (seen.has(id)) continue;
        summaries.delete(id);
        changed = true;
      }
      for (const file of hashes.keys()) if (!touched.has(file)) hashes.delete(file);
      return changed;
    },
    clear() {
      summaries.clear();
      hashes.clear();
    },
  };
}

export const tasksArchitecture = architectures();
