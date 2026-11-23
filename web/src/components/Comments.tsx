import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cutQuote, isArchived } from '../../../server/codeRef.ts';
import { sessionAction } from '../api.ts';
import { active } from '../outbox.ts';
import { useSends } from '../sends.ts';
import type { ActionBody, DocComment, Session } from '../types.ts';
import { ago } from '../util.ts';
import { explain, type Explanation } from './explain.ts';
import styles from './Comments.module.css';
import { toast } from './Toasts.tsx';

export const fileName = (path: string) => path.split('/').at(-1) ?? path;

export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export const commentAction = <A extends 'add-comment' | 'edit-comment' | 'archive-comment'>(s: Session, action: A, body: ActionBody<A>) =>
  sessionAction(s.id, action, body).then(() => true, (err: unknown) => {
    toast('error', err instanceof Error ? err.message : String(err), { session: s.id });
    return false;
  });

// The task's comments on its documents not sent yet, those on their way to Claude left out, the ones sent, and the
// ones archived, newest first.
export function useComments(session: Session) {
  const sending = new Set(useSends().filter(active).flatMap((i) => (i.sessionId === session.id ? i.body.comments ?? [] : [])));
  const kept = session.review.comments.filter((c) => !isArchived(c));
  return {
    open: kept.filter((c) => c.sentAt === null && !sending.has(c.id)),
    sent: kept.filter((c) => c.sentAt !== null),
    archived: session.review.comments.filter(isArchived).toSorted((a, b) => b.archivedAt! - a.archivedAt!),
  };
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

// Enter does the field's job and Shift+Enter breaks the line; Esc, when given, cancels.
const onEnter = (run: () => void, cancel?: () => void) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key === 'Escape' && cancel) {
    e.preventDefault();
    e.stopPropagation();
    cancel();
  }
  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
  e.preventDefault();
  run();
};

export interface Passage {
  path: string;
  version: number;
  quote: string;
  heading: string | null;
}

// A comment written about a passage selected in a document; Enter adds it to the document's comments, and nothing
// reaches Claude until they are sent.
export function CommentNote({ session, at, onDone }: { session: Session; at: Passage; onDone: () => void }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus({ preventScroll: true }), []);
  const add = () => {
    const t = text.trim();
    if (!t || saving) return;
    setSaving(true);
    void commentAction(session, 'add-comment', { ...at, text: t }).then((ok) => {
      setSaving(false);
      if (ok) onDone();
    });
  };
  return (
    <div className={styles.note} data-comment-note>
      <blockquote className={styles.quote}>{at.quote}</blockquote>
      <textarea
        className={styles.field}
        aria-label={`A comment on ${fileName(at.path)}`}
        placeholder="Write what should change. Enter adds it; Shift+Enter breaks the line."
        ref={field}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={onEnter(add, onDone)}
      />
      <div className={styles.actions}>
        <button type="button" onClick={onDone} data-explain="Esc">Cancel</button>
        <span className={styles.spacer} />
        <button type="button" data-variant="primary" data-explain="Adds it to this document's comments; nothing is sent" disabled={!text.trim() || saving} onClick={add}>Add comment</button>
      </div>
    </div>
  );
}

const short = (text: string) => (text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text);

function archive(session: Session, c: DocComment) {
  void commentAction(session, 'archive-comment', { comment: c.id, archived: true });
  toast('info', `Archived the comment “${short(c.text)}”`, {
    session: session.id,
    action: { label: 'Undo', run: () => void commentAction(session, 'archive-comment', { comment: c.id, archived: false }) },
  });
}

const restore = (session: Session, c: DocComment) => void commentAction(session, 'archive-comment', { comment: c.id, archived: false });

function Where({ comment: c, latest, onShow }: { comment: DocComment; latest: number; onShow?: ((c: DocComment) => void) | undefined }) {
  const older = c.version !== null && c.version < latest;
  return (
    <div className={styles.where}>
      {c.quote === null
        ? <span className={styles.whole} data-whole-label>Whole document</span>
        : (
          <button type="button" className={styles.passage} data-comment-passage disabled={!onShow} data-explain="Shows the passage in the document" onClick={() => onShow?.(c)}>
            {c.heading && <span className={styles.heading}>{c.heading}</span>}
            <blockquote className={styles.quote}>{c.quote}</blockquote>
          </button>
        )}
      {older && (
        <span className={styles.version} data-comment-version data-explain={`Written on v${c.version}; the document is at v${latest} now, which Claude is told when it gets the comment`}>
          v{c.version}, now v{latest}
        </span>
      )}
    </div>
  );
}

function OpenComment({ session, comment: c, latest, lit, onShow }: { session: Session; comment: DocComment; latest: number; lit: boolean; onShow: (c: DocComment) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const save = () => {
    const text = editing?.trim();
    if (!text) return;
    if (text !== c.text) void commentAction(session, 'edit-comment', { comment: c.id, text });
    setEditing(null);
  };
  return (
    <li className={styles.item} data-doc-comment={c.id} data-lit={lit || undefined}>
      <Where comment={c} latest={latest} onShow={onShow} />
      {editing === null
        ? <p className={styles.text}>{c.text}</p>
        : (
          <textarea
            className={styles.edit}
            aria-label="Edit the comment"
            value={editing}
            autoFocus
            onChange={(e) => setEditing(e.currentTarget.value)}
            onKeyDown={onEnter(save, () => setEditing(null))}
          />
        )}
      <div className={styles.actions}>
        <span className={styles.spacer} />
        {editing === null
          ? (
            <>
              <button type="button" data-explain="Edits the comment's text" onClick={() => setEditing(c.text)}>Edit</button>
              <button type="button" data-archive-comment data-explain="Moves the comment under Archived, where Restore brings it back" onClick={() => archive(session, c)}>Archive</button>
            </>
          )
          : (
            <>
              <button type="button" onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" data-variant="primary" disabled={!editing.trim()} onClick={save}>Save</button>
            </>
          )}
      </div>
    </li>
  );
}

function WholeField({ session, path, version }: { session: Session; path: string; version: number }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const add = () => {
    const t = text.trim();
    if (!t || saving) return;
    setSaving(true);
    void commentAction(session, 'add-comment', { path, version, quote: null, heading: null, text: t }).then((ok) => {
      setSaving(false);
      if (ok) setText('');
    });
  };
  return (
    <textarea
      className={styles.wholeField}
      data-whole-comment-field
      aria-label="Comment on the whole document"
      placeholder="Comment on the whole document"
      value={text}
      disabled={saving}
      onChange={(e) => setText(e.currentTarget.value)}
      onKeyDown={onEnter(add)}
    />
  );
}

interface PanelProps {
  session: Session;
  path: string;
  // The version shown, which a comment written now is on, and the document's latest.
  version: number;
  latest: number;
  open: DocComment[];
  sent: DocComment[];
  archived: DocComment[];
  lit: string | null;
  onShow: (c: DocComment) => void;
  onSend: () => void;
  sendTip: Explanation;
  blocked: string | null;
}

// The shown document's comments beside it: those not sent yet, each to edit or archive, a field for one on the whole
// document, the button that sends them, the ones sent before, and the archived ones to restore.
export function CommentsPanel({ session, path, version, latest, open, sent, archived, lit, onShow, onSend, sendTip, blocked }: PanelProps) {
  return (
    <aside className={styles.panel} aria-label="Comments" data-comments-panel>
      <h3 className={styles.label}>Comments{open.length > 0 && <span> · {open.length}</span>}</h3>
      {open.length > 0
        ? <ul className={styles.list}>{open.map((c) => <OpenComment key={c.id} session={session} comment={c} latest={latest} lit={lit === c.id} onShow={onShow} />)}</ul>
        : <p className={styles.none}>Select a passage to comment on it, or write about the whole document below. Nothing reaches Claude until you send them.</p>}
      <WholeField session={session} path={path} version={version} />
      {open.length > 0 && (
        <button type="button" className={styles.send} data-variant="primary" data-send-comments disabled={!!blocked} {...explain(blocked ? { does: blocked } : sendTip)} onClick={onSend}>
          Send {plural(open.length, 'comment')}
        </button>
      )}
      {sent.length > 0 && (
        <details className={styles.sent} data-sent-comments>
          <summary>Sent · {sent.length}</summary>
          <ul className={styles.list}>
            {sent.map((c) => (
              <li key={c.id} className={styles.item} data-doc-comment={c.id} data-sent>
                <Where comment={c} latest={latest} />
                <p className={styles.text}>{c.text}</p>
                <div className={styles.actions}>
                  <span className={styles.meta}>Sent {ago(c.sentAt!)}{c.version !== null && ` · on v${c.version}`}</span>
                  <span className={styles.spacer} />
                  <button type="button" data-archive-comment data-explain="Moves the sent comment under Archived, where Restore brings it back" onClick={() => archive(session, c)}>Archive</button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
      {archived.length > 0 && (
        <details className={styles.sent} data-archived-comments>
          <summary>Archived · {archived.length}</summary>
          <ul className={styles.list}>
            {archived.map((c) => (
              <li key={c.id} className={styles.item} data-doc-comment={c.id} data-archived>
                <Where comment={c} latest={latest} />
                <p className={styles.text}>{c.text}</p>
                <div className={styles.actions}>
                  <span className={styles.meta}>{c.sentAt === null ? 'Not sent' : `Sent ${ago(c.sentAt)}`} · archived {ago(c.archivedAt!)}</span>
                  <span className={styles.spacer} />
                  <button
                    type="button"
                    data-restore-comment
                    data-explain={c.sentAt === null ? 'Puts the comment back among those not sent yet' : 'Puts the comment back under Sent'}
                    onClick={() => restore(session, c)}
                  >
                    Restore
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </aside>
  );
}
