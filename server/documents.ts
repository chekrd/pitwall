import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { byWorkflow, isDocument, parseDocument, RPI_DIR, summarize, supportingKind, type DocumentEntry, type DocumentMeta, type SupportingFile, type TaskFolder, type Workflow } from './rpi.ts';

// The rpi documents of a task, read from `.pitwall/artifacts/<task folder>/` in each of its checkouts: its worktree,
// or its task folder and the worktrees it opened. Paths are given from `base`, the task's own folder.

const parsed = new Map<string, { mtimeMs: number; size: number; meta: DocumentMeta }>();
let touched: Set<string> | null = null;

// The artifacts folder of a checkout, or null when it is missing or `.pitwall` or `artifacts` leads out of it.
async function artifactsOf(root: string) {
  const dir = join(root, RPI_DIR);
  const [real, realRoot] = await Promise.all([realpath(dir).catch(() => null), realpath(root).catch(() => null)]);
  return real && realRoot && real === join(realRoot, RPI_DIR) ? { dir, real } : null;
}

async function metaOf(file: string, name: string, mtimeMs: number, size: number) {
  touched?.add(file);
  const hit = parsed.get(file);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.meta;
  const meta = parseDocument(name, await readFile(file, 'utf8'));
  parsed.set(file, { mtimeMs, size, meta });
  return meta;
}

async function readFolder(base: string, dir: string, name: string): Promise<TaskFolder> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const documents: DocumentEntry[] = [];
  const files: SupportingFile[] = [];
  await Promise.all(entries.filter((e) => e.isFile()).map(async (e) => {
    const file = join(dir, e.name);
    const st = await stat(file).catch(() => null);
    if (!st) return;
    const at = { path: relative(base, file), name: e.name, modifiedAt: Math.round(st.mtimeMs), size: st.size };
    if (isDocument(e.name)) {
      const meta = await metaOf(file, e.name, st.mtimeMs, st.size).catch(() => null);
      if (meta) documents.push({ ...at, ...meta });
      return;
    }
    const kind = supportingKind(e.name);
    if (kind) files.push({ ...at, kind });
  }));
  documents.sort(byWorkflow);
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { path: relative(base, dir), name, documents, files };
}

export async function taskFolders(base: string, roots: string[]): Promise<TaskFolder[]> {
  const lists = await Promise.all(roots.map(async (root) => {
    const artifacts = await artifactsOf(root);
    if (!artifacts) return [];
    const entries = await readdir(artifacts.dir, { withFileTypes: true }).catch(() => []);
    return Promise.all(entries.filter((e) => e.isDirectory()).map((e) => readFolder(base, join(artifacts.dir, e.name), e.name)));
  }));
  return lists.flat().filter((f) => f.documents.length || f.files.length).toSorted((a, b) => a.path.localeCompare(b.path));
}

// The file a document route names, from `base`: only ever one inside a checkout's `.pitwall/artifacts/`, after every
// symlink, never the folder itself.
export async function documentFile(base: string, roots: string[], path: string) {
  const parts = path.split('/');
  if (!path || isAbsolute(path) || path.includes('\0') || path.includes('\\') || parts.some((p) => !p || p === '.' || p === '..')) return null;
  const file = join(base, path);
  for (const root of roots) {
    const prefix = join(root, RPI_DIR) + sep;
    if (!file.startsWith(prefix)) continue;
    const artifacts = await artifactsOf(root);
    const real = await realpath(file).catch(() => null);
    if (!artifacts || !real || !real.startsWith(artifacts.real + sep)) return null;
    return (await stat(real).catch(() => null))?.isFile() ? real : null;
  }
  return null;
}

// Each task's summary, kept between syncs: a pass reads only the folders' listings and the documents whose mtime or
// size changed.
export function workflows() {
  const summaries = new Map<string, Workflow>();
  return {
    of: (id: string) => summaries.get(id) ?? null,
    // Answers whether any summary changed.
    async refresh(tasks: { id: string; base: string; roots: string[] }[]) {
      let changed = false;
      const seen = new Set<string>();
      const read = new Set<string>();
      touched = read;
      await Promise.all(tasks.map(async (t) => {
        seen.add(t.id);
        const next = summarize(await taskFolders(t.base, t.roots).catch(() => []));
        if (JSON.stringify(next) === JSON.stringify(summaries.get(t.id) ?? null)) return;
        if (next) summaries.set(t.id, next);
        else summaries.delete(t.id);
        changed = true;
      }));
      if (touched === read) {
        touched = null;
        for (const file of parsed.keys()) if (!read.has(file)) parsed.delete(file);
      }
      for (const id of summaries.keys()) {
        if (!seen.has(id)) {
          summaries.delete(id);
          changed = true;
        }
      }
      return changed;
    },
    clear() {
      summaries.clear();
      parsed.clear();
    },
  };
}

export const tasksWorkflows = workflows();
