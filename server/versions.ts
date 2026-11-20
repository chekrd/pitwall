import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VersionState } from './rpi.ts';

// Every version of a task's rpi documents, kept in Pitwall's state folder, never in the worktree: one folder a document,
// named by a hash of its path, with each version's text as `<n>.md` and an index of them. No version is ever dropped
// but with its task's folder.

export interface DocumentVersion {
  n: number;
  at: number;
  size: number;
  hash: string;
}

// A document is cut as a version once its text has stood unchanged this long while its task's Claude is not in a turn,
// so a turn that edits it in several steps makes one version.
export const SETTLE_MS = 2000;

export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

interface History {
  versions: DocumentVersion[];
  pending: { hash: string; since: number } | null;
}

interface Index {
  path: string;
  versions: DocumentVersion[];
}

export function documentVersions(dirOf: (task: string) => string, settleMs = SETTLE_MS) {
  const histories = new Map<string, History>();
  const loading = new Map<string, Promise<History>>();
  const locks = new Map<string, Promise<unknown>>();
  const keyOf = (task: string, path: string) => `${task}\0${path}`;
  const folderOf = (task: string, path: string) => join(dirOf(task), createHash('sha256').update(path).digest('hex').slice(0, 24));

  function history(task: string, path: string) {
    const key = keyOf(task, path);
    const hit = histories.get(key);
    if (hit) return Promise.resolve(hit);
    let load = loading.get(key);
    if (!load) {
      load = readFile(join(folderOf(task, path), 'index.json'), 'utf8')
        .then((t) => (JSON.parse(t) as Index).versions, () => [])
        .then((versions) => {
          const h = histories.get(key) ?? { versions, pending: null };
          histories.set(key, h);
          loading.delete(key);
          return h;
        });
      loading.set(key, load);
    }
    return load;
  }

  // One change to a document's history at a time, as two passes over the documents may overlap.
  function locked<T>(task: string, path: string, fn: () => Promise<T>): Promise<T> {
    const key = keyOf(task, path);
    const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }

  async function cut(task: string, path: string, h: History, text: string, at: number) {
    const folder = folderOf(task, path);
    const version = { n: (h.versions.at(-1)?.n ?? 0) + 1, at, size: Buffer.byteLength(text), hash: contentHash(text) };
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${version.n}.md`), text);
    const versions = [...h.versions, version];
    const index = join(folder, 'index.json');
    await writeFile(`${index}.tmp`, JSON.stringify({ path, versions } satisfies Index));
    await rename(`${index}.tmp`, index);
    h.versions = versions;
    h.pending = null;
  }

  return {
    // A document as a pass over the task's folders found it, its text's hash read with it. Answers whether what the
    // snapshot tells of it changed.
    observe: (task: string, path: string, file: string, hash: string, now: number, working: boolean) => locked(task, path, async () => {
      const h = await history(task, path);
      const was = JSON.stringify(state(h));
      if (h.versions.at(-1)?.hash === hash) h.pending = null;
      else if (h.pending?.hash !== hash) h.pending = { hash, since: now };
      else if (!working && now - h.pending.since >= settleMs) {
        const text = await readFile(file, 'utf8').catch(() => null);
        if (text === null) h.pending = null;
        else if (contentHash(text) !== hash) h.pending = { hash: contentHash(text), since: now };
        else await cut(task, path, h, text, now);
      }
      return JSON.stringify(state(h)) !== was;
    }),
    state: (task: string, path: string) => {
      const h = histories.get(keyOf(task, path));
      return h ? state(h) : null;
    },
    list: async (task: string, path: string) => (await history(task, path)).versions,
    text: async (task: string, path: string, n: number) => {
      const h = await history(task, path);
      if (!h.versions.some((v) => v.n === n)) return null;
      return readFile(join(folderOf(task, path), `${n}.md`), 'utf8').catch(() => null);
    },
    // A version written as it is, without waiting for it to settle; for the mock's made-up history.
    record: (task: string, path: string, text: string, at: number) => locked(task, path, async () => {
      const h = await history(task, path);
      if (h.versions.at(-1)?.hash !== contentHash(text)) await cut(task, path, h, text, at);
    }),
    // Drops what it holds of the tasks not named; their versions on disk go with each task's folder.
    keep: (tasks: ReadonlySet<string>) => {
      for (const key of histories.keys()) if (!tasks.has(key.split('\0')[0])) histories.delete(key);
    },
    clear: () => histories.clear(),
  };
}

const state = (h: History): VersionState => ({ latest: h.versions.at(-1)?.n ?? 0, settled: !h.pending });

export type DocumentVersions = ReturnType<typeof documentVersions>;
