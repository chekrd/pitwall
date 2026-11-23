import { randomUUID } from 'node:crypto';
import { isArchived } from './codeRef.ts';
import type { DocComment, Review } from './db.ts';
import { pruneOutdated, type Outdated, type Phase, type Workflow } from './rpi.ts';

export const MAX_COMMENTS = 200;
const MAX_TEXT = 20_000;

export const EMPTY_REVIEW: Review = { comments: [], outdated: {} };

function cleanText(text: string) {
  const t = text.trim();
  if (!t) throw new Error('the comment is empty');
  if (t.length > MAX_TEXT) throw new Error('the comment is too long');
  return t;
}

export interface NewComment {
  path: string;
  version: number | null;
  quote: string | null;
  heading: string | null;
  text: string;
}

// A task full of comments makes room by forgetting its oldest archived one, then its oldest sent one; one with only
// open comments takes no more.
export function addComment(r: Review, body: NewComment, now = Date.now()): Review {
  let comments = r.comments;
  if (comments.length >= MAX_COMMENTS) {
    const oldest = comments.filter(isArchived).toSorted((a, b) => a.archivedAt! - b.archivedAt!)[0]
      ?? comments.filter((c) => c.sentAt !== null).toSorted((a, b) => a.sentAt! - b.sentAt!)[0];
    if (!oldest) throw new Error(`a task holds at most ${MAX_COMMENTS} comments`);
    comments = comments.filter((c) => c !== oldest);
  }
  const comment: DocComment = {
    id: randomUUID(), path: body.path, version: body.version, quote: body.quote, heading: body.quote === null ? null : body.heading,
    text: cleanText(body.text), at: now, sentAt: null, archivedAt: null,
  };
  return { ...r, comments: [...comments, comment] };
}

export function editComment(r: Review, body: { comment: string; text: string }): Review {
  const found = r.comments.find((c) => c.id === body.comment);
  if (!found) throw new Error('this comment is gone');
  if (found.sentAt !== null) throw new Error('this comment was sent already');
  if (isArchived(found)) throw new Error('this comment is archived; restore it first');
  return { ...r, comments: r.comments.map((c) => (c === found ? { ...c, text: cleanText(body.text) } : c)) };
}

export function archiveComment(r: Review, body: { comment: string; archived: boolean }, now = Date.now()): Review {
  const found = r.comments.find((c) => c.id === body.comment);
  if (!found) throw new Error('this comment is gone');
  return { ...r, comments: r.comments.map((c) => (c === found ? { ...c, archivedAt: body.archived ? (found.archivedAt ?? now) : null } : c)) };
}

export const markSent = (r: Review, ids: readonly unknown[], now = Date.now()): Review =>
  ({ ...r, comments: r.comments.map((c) => (ids.includes(c.id) && c.sentAt === null && !isArchived(c) ? { ...c, sentAt: now } : c)) });

export function markOutdated(r: Review, marks: Outdated): Review {
  if (!Object.keys(marks).length) throw new Error('no later phase of this document is under way');
  return { ...r, outdated: { ...r.outdated, ...marks } };
}

export function keepPhase(r: Review, phase: Phase): Review {
  const { [phase]: _, ...outdated } = r.outdated;
  return { ...r, outdated };
}

// The review without the marks the workflow has moved past; the same review when it has moved past none.
export function pruneReview(r: Review, w: Workflow | null): Review {
  if (!w || !Object.keys(r.outdated).length) return r;
  const outdated = pruneOutdated(r.outdated, w);
  return Object.keys(outdated).length === Object.keys(r.outdated).length ? r : { ...r, outdated };
}
