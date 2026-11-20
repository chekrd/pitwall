import type { CodeRef, DocumentRef, Parked } from './db.ts';

// Also imported by the UI, so nothing imported here may load the server.

export const MAX_REF_LINES = 40;
export const MAX_REF_LINE = 400;

export const refLines = (r: Pick<CodeRef, 'start' | 'end'>) => (r.start === r.end ? `line ${r.start}` : `lines ${r.start}–${r.end}`);

function fenced(lines: readonly string[]) {
  const longest = Math.max(2, ...lines.map((l) => Math.max(0, ...[...l.matchAll(/`+/g)].map((m) => m[0].length))));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${lines.join('\n')}\n${fence}`;
}

export const MAX_QUOTE = 600;

export const isDocumentRef = (r: Parked['ref']): r is DocumentRef => r?.kind === 'document';

// A passage as a comment keeps it: trimmed, and at most MAX_QUOTE characters, the rest cut with an ellipsis.
export function cutQuote(text: string) {
  const t = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_QUOTE ? `${t.slice(0, MAX_QUOTE - 1).trimEnd()}…` : t;
}

const quoted = (quote: string) => quote.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');

const commented = (r: DocumentRef, text: string) => `${quoted(r.quote)}\n\n${text}`;

// The comments on one document as one rpi command, `update <path>` on the command's own first line; each comment
// follows as its heading, the passage quoted, then what was written about it.
export function documentCommentsMessage(invocation: string, path: string, drafts: readonly Pick<Parked, 'text' | 'ref'>[]) {
  const parts = drafts.flatMap(({ ref: r, text }) => (isDocumentRef(r) ? [r.heading ? `Under “${r.heading}”:\n${commented(r, text)}` : commented(r, text)] : []));
  return [`${invocation} update ${path}`, ...parts].join('\n\n');
}

// What Claude gets for a draft: the lines or the passage it was written about, when it was, then the draft.
export function draftMessage(p: Pick<Parked, 'text' | 'ref'>) {
  const r = p.ref;
  if (!r) return p.text;
  if (isDocumentRef(r)) return `About \`${r.path}\`${r.heading ? `, under “${r.heading}”` : ''}:\n${commented(r, p.text)}`;
  const where = r.side === 'old' ? ` as the base branch has them (the diff removes or changes them)` : '';
  const count = r.end - r.start + 1;
  const cut = r.lines.length && r.lines.length < count ? ` (the first ${r.lines.length} of ${count} lines)` : '';
  const code = r.lines.length ? `\n${fenced(r.lines)}${cut}` : '';
  return `About \`${r.path}\` ${refLines(r)}${where}:${code}\n\n${p.text}`;
}
