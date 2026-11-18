import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import { MAX_REF_LINE, MAX_REF_LINES } from '../../server/codeRef.ts';
import type { CodeRef } from './types.ts';

type Side = 'additions' | 'deletions';

// Where a draft's lines are, as the Diff tab's item in the page's address: `new:89-91:server/git.ts`.
export const spotOf = (r: Pick<CodeRef, 'path' | 'side' | 'start' | 'end'>) => encodeURIComponent(`${r.side}:${r.start}-${r.end}:${r.path}`);

export function parseSpot(item: string | null): Omit<CodeRef, 'lines'> | null {
  let text: string;
  try {
    text = decodeURIComponent(item ?? '');
  } catch {
    return null;
  }
  const m = text.match(/^(old|new):(\d+)-(\d+):(.+)$/);
  return m ? { side: m[1] as CodeRef['side'], start: Number(m[2]), end: Number(m[3]), path: m[4] } : null;
}

// A partial diff holds only its hunks' lines, so a line number is found through the hunk it falls in.
function lineAt(file: FileDiffMetadata, side: Side, n: number) {
  const all = side === 'additions' ? file.additionLines : file.deletionLines;
  if (!file.isPartial) return all[n - 1];
  for (const h of file.hunks) {
    const [start, count, index] = side === 'additions' ? [h.additionStart, h.additionCount, h.additionLineIndex] : [h.deletionStart, h.deletionCount, h.deletionLineIndex];
    if (n >= start && n < start + count) return all[index + n - start];
  }
  return undefined;
}

export function codeRef(file: FileDiffMetadata, range: SelectedLineRange): CodeRef {
  const side: Side = range.side ?? range.endSide ?? 'additions';
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  const lines: string[] = [];
  for (let n = start; n <= end && lines.length < MAX_REF_LINES; n++) {
    const line = lineAt(file, side, n);
    if (line === undefined) break;
    const text = line.replace(/\r?\n$/, '');
    lines.push(text.length > MAX_REF_LINE ? `${text.slice(0, MAX_REF_LINE - 1)}…` : text);
  }
  return { path: file.name, side: side === 'additions' ? 'new' : 'old', start, end, lines };
}
