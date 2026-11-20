import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { cutQuote, isDocumentRef } from '../../../server/codeRef.ts';
import { showTab } from '../router.ts';
import { active } from '../outbox.ts';
import { useSends } from '../sends.ts';
import type { DocumentRef, Parked, Session } from '../types.ts';
import { explain, TIPS } from './explain.ts';
import { park } from './Later.tsx';
import styles from './Comments.module.css';
import { toast } from './Toasts.tsx';
import { documentItem } from './Workflow.tsx';

export type Comment = Parked & { ref: DocumentRef };

export const fileName = (path: string) => path.split('/').at(-1) ?? path;

export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

// The task's comments on its documents still under Later, those on their way to Claude left out.
export function useComments(session: Session): Comment[] {
  const sending = new Set(useSends().filter(active).flatMap((i) => (i.sessionId === session.id ? i.body.drafts ?? [] : [])));
  return session.parked.filter((d): d is Comment => isDocumentRef(d.ref) && !sending.has(d.id));
}

// The comment Later asked the Documents tab to show, until it has.
let wanted: { path: string; id: string } | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const fn of listeners) fn();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export const useWantedComment = () => useSyncExternalStore(subscribe, () => wanted);

export function shownComment() {
  wanted = null;
  changed();
}

export function openComment(session: Session, comment: Comment) {
  if (!session.workflow) {
    toast('info', `${fileName(comment.ref.path)} is gone from the task's folder; the comment stays under Later`, { session: session.id });
    return;
  }
  wanted = { path: comment.ref.path, id: comment.id };
  changed();
  showTab('documents', documentItem(comment.ref.path));
}

const MARK = 'mark[data-comment]';

// The text under `root` with its whitespace left out, each character with the text node and offset it came from, so
// a passage is found again however the page broke its lines and blocks.
function textIndex(root: Element) {
  const at: [Text, number][] = [];
  let flat = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const data = node.data;
    for (let i = 0; i < data.length; i++) {
      if (/\s/.test(data[i])) continue;
      flat += data[i];
      at.push([node, i]);
    }
  }
  return { flat, at };
}

// A quote cut with an ellipsis is looked for by what comes before it.
function find(index: ReturnType<typeof textIndex>, quote: string) {
  const want = quote.replace(/…$/, '').replace(/\s+/g, '');
  const start = want ? index.flat.indexOf(want) : -1;
  if (start < 0) return null;
  const [first, from] = index.at[start];
  const [last, to] = index.at[start + want.length - 1];
  return { first, from, last, to: to + 1 };
}

function wrap(root: Element, span: NonNullable<ReturnType<typeof find>>, id: string, note: string) {
  const range = document.createRange();
  range.setStart(span.first, span.from);
  range.setEnd(span.last, span.to);
  const parts: [Text, number, number][] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (!range.intersectsNode(node)) continue;
    const from = node === span.first ? span.from : 0;
    const to = node === span.last ? span.to : node.length;
    if (from < to && node.data.slice(from, to).trim()) parts.push([node, from, to]);
  }
  for (const [node, from, to] of parts) {
    if (to < node.length) node.splitText(to);
    const piece = from > 0 ? node.splitText(from) : node;
    const mark = document.createElement('mark');
    mark.dataset.comment = id;
    if (note) mark.dataset.explain = note;
    piece.replaceWith(mark);
    mark.append(piece);
  }
}

export interface Marked {
  id: string;
  quote: string;
  note: string;
}

// Marks each passage still in the document; one whose quote no longer occurs stays unmarked. Answers the ids marked.
export function markPassages(root: Element, passages: readonly Marked[]) {
  for (const m of root.querySelectorAll(MARK)) m.replaceWith(...m.childNodes);
  root.normalize();
  const found = new Set<string>();
  for (const p of passages) {
    const span = find(textIndex(root), p.quote);
    if (!span) continue;
    wrap(root, span, p.id, p.note);
    found.add(p.id);
  }
  return found;
}

// The heading nearest above `node` in the document, or the one it lies in.
export function headingAbove(root: Element, node: Node) {
  let found: Element | null = null;
  for (const h of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (h.contains(node) || h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) found = h;
    else break;
  }
  return found?.textContent.trim() || null;
}

export interface Picked {
  quote: string;
  heading: string | null;
  top: number;
  left: number;
}

// The passage selected in the document under `root`, placed under its last line within `scroller`.
export function pickedIn(root: Element, scroller: HTMLElement): Picked | null {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  const range = sel.getRangeAt(0);
  const quote = cutQuote(sel.toString());
  if (!quote) return null;
  const rects = [...range.getClientRects()].filter((r) => r.width || r.height);
  const last = rects.at(-1) ?? range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  return {
    quote,
    heading: headingAbove(root, range.startContainer),
    top: last.bottom - box.top + scroller.scrollTop + 6,
    left: Math.max(0, Math.min(last.left - box.left + scroller.scrollLeft, scroller.clientWidth - 120)),
  };
}

// A comment written about a passage selected in a document. Enter keeps it under Later, so nothing reaches Claude from
// here; it goes with the document's other comments, from Later, or by itself when armed.
export function CommentNote({ session, at, onDone }: { session: Session; at: DocumentRef; onDone: () => void }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus({ preventScroll: true }), []);
  const keep = (auto: boolean) => {
    const t = text.trim();
    if (!t || saving) return;
    setSaving(true);
    void park(session, 'park', { text: t, auto, ref: at }).then((ok) => {
      setSaving(false);
      if (!ok) return;
      const where = `a comment on ${fileName(at.path)}`;
      toast('info', auto ? `Goes to Claude when it's your turn: ${where}` : `Kept for later: ${where}`, { session: session.id });
      onDone();
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onDone();
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    keep(false);
  };
  return (
    <div className={styles.note} data-comment-note>
      <blockquote className={styles.quote}>{at.quote}</blockquote>
      <textarea
        className={styles.field}
        aria-label={`A comment on ${fileName(at.path)}`}
        placeholder="Write what should change. Enter keeps it for later; Shift+Enter breaks the line."
        ref={field}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div className={styles.actions}>
        <button type="button" onClick={onDone} data-explain="Esc">Cancel</button>
        <span className={styles.spacer} />
        <button type="button" {...explain(TIPS.autoKeep)} disabled={!text.trim() || saving} onClick={() => keep(true)}>Send when it's my turn</button>
        <button type="button" data-variant="primary" {...explain(TIPS.keep)} disabled={!text.trim() || saving} onClick={() => keep(false)}>Keep for later</button>
      </div>
    </div>
  );
}
