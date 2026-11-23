import type { CodeRef, DocComment, Parked } from './db.ts';
import { BOARD_HANDOFF } from './rpi.ts';

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

// A passage as a comment keeps it: trimmed, and at most MAX_QUOTE characters, the rest cut with an ellipsis.
export function cutQuote(text: string) {
  const t = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_QUOTE ? `${t.slice(0, MAX_QUOTE - 1).trimEnd()}…` : t;
}

const quoted = (quote: string) => quote.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');

// Only a comment written on a version of its document older than `latest` says which, as its passage may have moved.
export function olderVersion(c: Pick<DocComment, 'version'>, latest: number | null | undefined) {
  return c.version && latest && c.version < latest ? `written on version ${c.version}; the document is at version ${latest} now, so the passage may have moved` : null;
}

function commentPart(c: Pick<DocComment, 'quote' | 'heading' | 'text' | 'version'>, latest: number | null | undefined) {
  if (c.quote === null) return `About the whole document:\n${c.text}`;
  const older = olderVersion(c, latest);
  const body = `${quoted(c.quote)}\n\n${c.text}`;
  if (c.heading) return `Under “${c.heading}”${older ? ` (${older})` : ''}:\n${body}`;
  return older ? `${older[0].toUpperCase()}${older.slice(1)}:\n${body}` : body;
}

// The comments on one document as one rpi command, `update <path>` on the command's own first line; each comment on a
// passage follows as its heading, the passage quoted, then what was written about it, and each on the whole document
// as itself. `latest` is the document's version now.
export function documentCommentsMessage(invocation: string, path: string, comments: readonly Pick<DocComment, 'quote' | 'heading' | 'text' | 'version'>[], latest?: number | null) {
  return [`${invocation} update ${path}`, ...comments.map((c) => commentPart(c, latest)), BOARD_HANDOFF].join('\n\n');
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
