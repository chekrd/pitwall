import { open, type FileHandle } from 'node:fs/promises';

export const HEAD_BYTES = 128 << 10;
export const TAIL_BYTES = 512 << 10;
export const MAX_TAIL_BYTES = 8 << 20;
const MAX_LINE = 256 << 10;

type Entry = Record<string, any>;

export interface Entries {
  head: Entry[];
  tail: Entry[];
}

// A line too long to read, or one that is not JSON, as a partly written last line.
const SKIPPED = undefined;

function parse(line: string): Entry | typeof SKIPPED {
  if (line.length > MAX_LINE) return SKIPPED;
  try {
    return JSON.parse(line);
  } catch {
    return SKIPPED;
  }
}

export const jsonLines = (text: string): Entry[] => text.split('\n').flatMap((line) => {
  const entry = parse(line);
  return entry === SKIPPED ? [] : [entry];
});

async function range(fh: FileHandle, from: number, to: number) {
  const buf = Buffer.alloc(Math.max(0, to - from));
  if (buf.length) await fh.read(buf, 0, buf.length, from);
  return buf;
}

// Screenshots and other tool output are stored inline and can fill any fixed window, so the tail grows until it
// reaches the developer's last prompt, where the current turn starts. Read whole, every time.
export async function readEntriesWhole(file: string, isPrompt: (e: Entry) => unknown): Promise<Entries> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const head = jsonLines((await range(fh, 0, Math.min(HEAD_BYTES, size))).toString('utf8'));
    for (let bytes = TAIL_BYTES; ; bytes *= 4) {
      const tail = jsonLines((await range(fh, Math.max(0, size - bytes), size)).toString('utf8'));
      if (bytes >= size || bytes >= MAX_TAIL_BYTES || tail.some(isPrompt)) return { head, tail };
    }
  } finally {
    await fh.close();
  }
}

// The complete lines of a file from `from` to `end`, each parsed once: Claude only appends to a transcript, so a read
// after it grew parses only the new lines. What it returns is what readEntriesWhole would: a window that starts inside
// a line holds that line's rest, as text split at newlines does, and newlines are where UTF-8 decoding resyncs.
interface LineIndex {
  ino: number;
  from: number;
  end: number;
  starts: number[];
  entries: (Entry | typeof SKIPPED)[];
  // The bytes before `end`, which tell a file that grew from one rewritten.
  check: Buffer;
  // Once the file reached HEAD_BYTES, the head no longer changes.
  head: Entry[] | null;
}

const NL = 0x0a;
const CHECK_BYTES = 256;
const MAX_INDEXED = 16;
const indexes = new Map<string, LineIndex>();

function linesIn(buf: Buffer, base: number, first: number) {
  const starts: number[] = [];
  const entries: (Entry | typeof SKIPPED)[] = [];
  let at = first - base;
  for (let nl = buf.indexOf(NL, at); nl >= 0; nl = buf.indexOf(NL, at)) {
    starts.push(base + at);
    entries.push(parse(buf.toString('utf8', at, nl)));
    at = nl + 1;
  }
  return { starts, entries, end: base + at };
}

// The first line start at or after `w`, from the bytes [w - 1, …) in buf; null when none is in it.
function firstStart(buf: Buffer, base: number, w: number) {
  if (w === 0 || buf[w - 1 - base] === NL) return w;
  const nl = buf.indexOf(NL, w - base);
  return nl < 0 ? null : base + nl + 1;
}

const lowerBound = (xs: number[], x: number) => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

async function startIndex(fh: FileHandle, ino: number, size: number): Promise<LineIndex | null> {
  const w = Math.max(0, size - TAIL_BYTES);
  const base = Math.max(0, w - 1);
  const buf = await range(fh, base, size);
  const first = firstStart(buf, base, w);
  if (first === null) return null;
  const lines = linesIn(buf, base, first);
  return { ino, from: first, ...lines, check: Buffer.alloc(0), head: null };
}

async function extendBack(fh: FileHandle, idx: LineIndex, w: number) {
  const base = Math.max(0, w - 1);
  const buf = await range(fh, base, idx.from);
  const first = firstStart(buf, base, w) ?? idx.from;
  if (first >= idx.from) return;
  const lines = linesIn(buf, base, first);
  idx.starts = lines.starts.concat(idx.starts);
  idx.entries = lines.entries.concat(idx.entries);
  idx.from = first;
}

async function windowOf(fh: FileHandle, idx: LineIndex, w: number, size: number): Promise<Entry[]> {
  if (w >= idx.end) return jsonLines((await range(fh, w, size)).toString('utf8'));
  if (w < idx.from) await extendBack(fh, idx, w);
  const i = lowerBound(idx.starts, w);
  const next = i < idx.starts.length ? idx.starts[i] : idx.end;
  const out: Entry[] = [];
  const add = (e: Entry | typeof SKIPPED) => {
    if (e !== SKIPPED) out.push(e);
  };
  if (next !== w) add(parse((await range(fh, w, next - 1)).toString('utf8')));
  for (let j = i; j < idx.entries.length; j++) add(idx.entries[j]);
  add(parse((await range(fh, idx.end, size)).toString('utf8')));
  return out;
}

// readEntriesWhole's result, parsing only what the last read of the file did not.
export async function readEntries(file: string, isPrompt: (e: Entry) => unknown): Promise<Entries> {
  const fh = await open(file, 'r');
  try {
    const { size, ino } = await fh.stat();
    let idx = indexes.get(file);
    indexes.delete(file);
    if (idx && (idx.ino !== ino || size < idx.end || !(await range(fh, idx.end - idx.check.length, idx.end)).equals(idx.check))) idx = undefined;
    if (idx && size > idx.end) {
      const grown = linesIn(await range(fh, idx.end, size), idx.end, idx.end);
      for (let k = 0; k < grown.starts.length; k++) {
        idx.starts.push(grown.starts[k]);
        idx.entries.push(grown.entries[k]);
      }
      idx.end = grown.end;
    }
    idx ??= (await startIndex(fh, ino, size)) ?? undefined;
    if (!idx) return await readEntriesWhole(file, isPrompt);
    const head = idx.head ?? jsonLines((await range(fh, 0, Math.min(HEAD_BYTES, size))).toString('utf8'));
    if (size >= HEAD_BYTES) idx.head = head;
    let tail: Entry[];
    for (let bytes = TAIL_BYTES; ; bytes *= 4) {
      tail = await windowOf(fh, idx, Math.max(0, size - bytes), size);
      if (bytes >= size || bytes >= MAX_TAIL_BYTES || tail.some(isPrompt)) break;
    }
    // No later window reaches further back than the largest one does now.
    const keep = lowerBound(idx.starts, size - MAX_TAIL_BYTES);
    if (keep > 0) {
      idx.starts = idx.starts.slice(keep);
      idx.entries = idx.entries.slice(keep);
      idx.from = idx.starts[0] ?? idx.end;
    }
    idx.check = await range(fh, Math.max(0, idx.end - CHECK_BYTES), idx.end);
    indexes.set(file, idx);
    if (indexes.size > MAX_INDEXED) indexes.delete(indexes.keys().next().value!);
    return { head, tail };
  } finally {
    await fh.close();
  }
}

export const forgetIndexes = () => indexes.clear();
