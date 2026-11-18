import type { CodeRef, Parked } from './db.ts';

// Also imported by the UI, so nothing imported here may load the server.

export const MAX_REF_LINES = 40;
export const MAX_REF_LINE = 400;

export const refLines = (r: Pick<CodeRef, 'start' | 'end'>) => (r.start === r.end ? `line ${r.start}` : `lines ${r.start}–${r.end}`);

function fenced(lines: readonly string[]) {
  const longest = Math.max(2, ...lines.map((l) => Math.max(0, ...[...l.matchAll(/`+/g)].map((m) => m[0].length))));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${lines.join('\n')}\n${fence}`;
}

// What Claude gets for a draft: the lines it was written about, when it was, then the draft.
export function draftMessage(p: Pick<Parked, 'text' | 'ref'>) {
  const r = p.ref;
  if (!r) return p.text;
  const where = r.side === 'old' ? ` as the base branch has them (the diff removes or changes them)` : '';
  const count = r.end - r.start + 1;
  const cut = r.lines.length && r.lines.length < count ? ` (the first ${r.lines.length} of ${count} lines)` : '';
  const code = r.lines.length ? `\n${fenced(r.lines)}${cut}` : '';
  return `About \`${r.path}\` ${refLines(r)}${where}:${code}\n\n${p.text}`;
}
