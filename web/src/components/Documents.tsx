import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { documentCommentsMessage } from '../../../server/codeRef.ts';
import { nextSteps, TYPE_LABELS, type NextStep } from '../../../server/rpi.ts';
import { rpiInvocation } from '../../../server/slash.ts';
import { api } from '../api.ts';
import { SHEET_DIALOG } from '../keys.ts';
import { sessionPath, showTab } from '../router.ts';
import { hold } from '../sends.ts';
import type { Command, DocumentEntry, Session, SupportingFile, TaskFolder, Workflow } from '../types.ts';
import { ago } from '../util.ts';
import { CommentNote, fileName, markPassages, pickedIn, plural, shownComment, useComments, useWantedComment, type Comment, type Marked, type Picked } from './Comments.tsx';
import { useCommands } from './Composer.tsx';
import styles from './Documents.module.css';
import { explain, SENDS, type Explanation } from './explain.ts';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { toast } from './Toasts.tsx';
import { documentItem, PhaseStrip } from './Workflow.tsx';

export const documentUrl = (session: string, path: string) => `/api/sessions/${session}/documents/${path.split('/').map(encodeURIComponent).join('/')}`;

// A path a document names, from the folder the document lies in; null for a link to another site or to the page itself.
function relativeTo(doc: string, to: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(to) || to.startsWith('#') || to.startsWith('/')) return null;
  const url = new URL(to, `file:///${doc}`);
  return decodeURIComponent(url.pathname.slice(1));
}

type Shown = { kind: 'document'; entry: DocumentEntry } | { kind: 'file'; entry: SupportingFile };

// Why what the Documents tab sends cannot go now, or null when it can: only at the end of a turn, as a command
// typed mid-turn would wait for the turn's end, and one typed under a question would answer it.
function sendBlocked(s: Session, commands: readonly Command[] | null) {
  if (s.archived) return 'The task is archived; unarchive it first.';
  if (s.status === 'exited') return "The task's Claude has ended; continue it first.";
  if (s.status === 'working') return 'Claude is at work; this can go once its turn has ended.';
  if (s.status === 'waiting' || s.menu) return 'Claude is showing a question in its terminal, which this would answer: answer it first.';
  if (!commands) return "Reading Claude's commands…";
  return null;
}

const FRESH = 'pitwall:rpi-fresh';

function useFresh() {
  const [fresh, setFresh] = useState(() => {
    try {
      return localStorage.getItem(FRESH) !== '0';
    } catch {
      return true;
    }
  });
  const choose = (on: boolean) => {
    setFresh(on);
    try {
      localStorage.setItem(FRESH, on ? '1' : '0');
    } catch {
      // A page without storage keeps it in memory only.
    }
  };
  return [fresh, choose] as const;
}

function stepTip(command: string, fresh: boolean): Explanation {
  if (!fresh) return SENDS.prompt(command);
  return { ...SENDS.prompt(`/clear”, then, once Claude has started the new conversation, “${command}`), sees: "a new conversation: /clear leaves this one behind, and rpi reads the task's documents" };
}

// rpi's next steps from the phase under way, each sent as rpi's own command for the task's folder and flow; with Fresh
// conversation, after a /clear, as rpi runs each phase in a context of its own.
function NextSteps({ session, name, workflow, commands, comments }: { session: Session; name: string; workflow: Workflow; commands: readonly Command[] | null; comments: Comment[] }) {
  const [fresh, setFresh] = useFresh();
  const steps = nextSteps(workflow, rpiInvocation(commands ?? []));
  if (!steps.length) return null;
  const blocked = sendBlocked(session, commands);
  const current = workflow.steps.find((s) => s.state === 'current')?.document;
  const open = current ? comments.filter((c) => c.ref.path === current).length : 0;
  const send = (step: NextStep) => {
    const label = fresh ? `/clear, then ${step.command}` : step.command;
    void hold(session, { action: 'answer', body: { key: null, text: step.command, ...(fresh && { fresh: true }) }, label, command: true }, name, { box: false });
  };
  return (
    <div className={styles.next} data-next-steps>
      {open > 0 && (
        <span className={styles.unsent} data-unsent-comments data-explain={`The ${fileName(current!)} document has comments under Later that Claude has not had yet`}>
          {plural(open, 'comment')} not sent
        </span>
      )}
      {steps.map((step) => (
        <button key={step.label} type="button" data-variant={step.usual ? 'primary' : undefined} data-step={step.label} disabled={!!blocked} {...explain(blocked ? { does: blocked } : stepTip(step.command, fresh))} onClick={() => send(step)}>
          {step.label}
        </button>
      ))}
      <label className={styles.fresh} data-explain="Starts the next step in a new conversation with /clear, as rpi recommends a context of its own for each phase; the documents carry what it needs">
        <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.currentTarget.checked)} />
        Fresh conversation
      </label>
    </div>
  );
}

// The task's rpi documents, as they stand on disk: read when the tab opens and again whenever the snapshot's stamp
// says a file changed.
export function Documents({ session, name, item }: { session: Session; name: string; item: string | null }) {
  const workflow = session.workflow ?? null;
  const [folders, setFolders] = useState<TaskFolder[] | null>(null);
  const stamp = workflow?.stamp;
  useEffect(() => {
    let live = true;
    api('GET', `/api/sessions/${session.id}/documents`).then((f) => live && setFolders(f), () => live && setFolders((was) => was ?? []));
    return () => {
      live = false;
    };
  }, [session.id, stamp]);
  const comments = useComments(session);
  const commands = useCommands(session.worktree, true);
  const opening = useWantedComment();
  useEffect(() => {
    if (!folders || !opening || folders.some((f) => f.documents.some((d) => d.path === opening.path))) return;
    toast('info', `${fileName(opening.path)} is gone from the task's folder; the comment stays under Later`, { session: session.id });
    shownComment();
  }, [folders, opening, session.id]);

  const frame = useRef<HTMLIFrameElement>(null);
  // As in Artifacts: keys typed into the frame are its own, so the page takes focus back once the pointer leaves it.
  useEffect(() => {
    const back = () => {
      if (frame.current && document.activeElement === frame.current) document.getElementById(SHEET_DIALOG)?.focus();
    };
    document.addEventListener('pointermove', back);
    return () => document.removeEventListener('pointermove', back);
  }, []);

  if (!folders) return <p className={styles.empty}>Reading the documents…</p>;
  const documents = folders.flatMap((f) => f.documents);
  const files = folders.flatMap((f) => f.files);
  const wanted = item ? decodeURIComponent(item) : null;
  const preferred = workflow?.steps.find((s) => s.state === 'current')?.document ?? workflow?.steps.findLast((s) => s.document)?.document;
  const pick = (path: string | null | undefined): Shown | null => {
    const doc = documents.find((d) => d.path === path);
    if (doc) return { kind: 'document', entry: doc };
    const file = files.find((f) => f.path === path);
    return file ? { kind: 'file', entry: file } : null;
  };
  const shown = pick(wanted) ?? pick(preferred) ?? (documents[0] ? { kind: 'document', entry: documents[0] } : null);
  if (!shown) return <p className={styles.empty}>The documents of this task are gone from its worktree.</p>;

  const select = (path: string) => showTab('documents', documentItem(path));
  return (
    <div className={styles.page}>
      {workflow && (
        <div className={styles.strip}>
          <PhaseStrip session={session.id} workflow={workflow} />
          <NextSteps session={session} name={name} workflow={workflow} commands={commands} comments={comments} />
        </div>
      )}
      <div className={styles.documents}>
        <nav className={styles.list} aria-label="Documents">
          {folders.map((f) => (
            <section key={f.path} aria-label={f.name}>
              {folders.length > 1 && <h3 className={styles.folder}>{f.name}</h3>}
              {f.documents.map((d) => {
                const count = comments.filter((c) => c.ref.path === d.path).length;
                return (
                  <button key={d.path} type="button" data-ux="document" data-document={d.path} aria-current={shown.entry.path === d.path || undefined} onClick={() => select(d.path)}>
                    <strong>{d.title ?? d.name}</strong>
                    <span>{d.type ? TYPE_LABELS[d.type] : 'Document'} · {ago(d.modifiedAt)}</span>
                    {count > 0 && <span className={styles.count} data-comment-count data-explain="Comments under Later that Claude has not had yet">{plural(count, 'comment')}</span>}
                  </button>
                );
              })}
              {f.files.length > 0 && <h4 className={styles.folder}>Mockups and images</h4>}
              {f.files.map((file) => (
                <button key={file.path} type="button" data-ux="document file" data-document={file.path} aria-current={shown.entry.path === file.path || undefined} onClick={() => select(file.path)}>
                  <strong>{file.name}</strong>
                  <span>{file.kind === 'mockup' ? 'Mockup' : 'Image'} · {ago(file.modifiedAt)}</span>
                </button>
              ))}
            </section>
          ))}
        </nav>
        {shown.kind === 'document'
          ? (
            <DocumentView
              key={shown.entry.path}
              session={session}
              name={name}
              doc={shown.entry}
              known={[...documents, ...files].map((d) => d.path).join('\n')}
              comments={comments.filter((c) => c.ref.path === shown.entry.path)}
              focus={opening?.path === shown.entry.path ? opening.id : null}
              blocked={sendBlocked(session, commands)}
              invocation={rpiInvocation(commands ?? [])}
            />
          )
          : <FileView session={session.id} file={shown.entry} frame={frame} />}
      </div>
    </div>
  );
}

function Header({ session, path, title, detail, children }: { session: string; path: string; title: string; detail: string; children?: ReactNode }) {
  return (
    <header>
      <strong>{title}</strong>
      <span>{detail}</span>
      {children}
      <a href={documentUrl(session, path)} target="_blank" rel="noreferrer">
        Open in new tab <Icon name="external" size={14} />
      </a>
    </header>
  );
}

interface ViewProps {
  session: Session;
  name: string;
  doc: DocumentEntry;
  known: string;
  comments: Comment[];
  // The comment Later opened the document at.
  focus: string | null;
  blocked: string | null;
  invocation: string;
}

const NEW = 'new';

// Kept on screen while a newer version is read, so a change on disk redraws the document where you were reading.
// `known` lists the paths beside it, one a line, so the rewritten links stay the same, and the document is not drawn
// again, until a file comes or goes. A passage selected in it takes a comment, and the passages commented are marked.
function DocumentView({ session, name, doc, known, comments, focus, blocked, invocation }: ViewProps) {
  const id = session.id;
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(documentUrl(id, doc.path), { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))))
      .then((t) => {
        if (!live) return;
        setText(t);
        setFailed(false);
      }, () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [id, doc.path, doc.modifiedAt, doc.size]);

  const paths = useMemo(() => new Set(known.split('\n')), [known]);
  const href = useCallback((to: string, image: boolean) => {
    const path = relativeTo(doc.path, to);
    if (path === null) return image ? null : to;
    if (image || !paths.has(path)) return documentUrl(id, path);
    return sessionPath(id, 'documents', documentItem(path));
  }, [id, doc.path, paths]);
  // A link to another document or a mockup opens in the tab, in place of this entry; one to any other file beside
  // them in a tab of its own, never in the board's window.
  const follow = (e: MouseEvent<HTMLDivElement>) => {
    const to = (e.target as Element).closest('a')?.getAttribute('href');
    if (!to || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const tab = `${sessionPath(id, 'documents')}/`;
    if (to.startsWith(tab)) {
      e.preventDefault();
      showTab('documents', to.slice(tab.length));
    } else if (to.startsWith(documentUrl(id, ''))) {
      e.preventDefault();
      window.open(to, '_blank', 'noreferrer');
    }
  };

  const scroller = useRef<HTMLDivElement>(null);
  const markdown = () => scroller.current?.querySelector<HTMLElement>(':scope > [data-markdown]') ?? null;
  const [picked, setPicked] = useState<Picked | null>(null);
  const [writing, setWriting] = useState<Picked | null>(null);
  // Read once a press in the document ends, so the button does not chase a selection still being dragged.
  useEffect(() => {
    let pressed = false;
    const read = () => {
      const root = markdown();
      if (!pressed) setPicked(root && scroller.current ? pickedIn(root, scroller.current) : null);
    };
    const down = (e: PointerEvent) => {
      pressed = !!scroller.current?.contains(e.target as Node);
    };
    const up = () => {
      if (!pressed) return;
      pressed = false;
      read();
    };
    document.addEventListener('selectionchange', read);
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    return () => {
      document.removeEventListener('selectionchange', read);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
    };
  }, []);

  // The snapshot brings new draft objects on every change of the task, which would mark the document again each time.
  const commented = JSON.stringify(comments.map((c) => [c.id, c.ref.quote, c.text]));
  const passages = useMemo<Marked[]>(() => [
    ...comments.map((c) => ({ id: c.id, quote: c.ref.quote, note: c.text })),
    ...(writing ? [{ id: NEW, quote: writing.quote, note: '' }] : []),
  ], [commented, writing]);
  const lit = useRef<string | null>(null);
  // The page redraws parts of a document after it is in place (code coloured, diagrams drawn), which takes the marks
  // with them, so they are put back after every change under it.
  useEffect(() => {
    const root = markdown();
    if (!root || text === null) return;
    const observer = new MutationObserver(() => apply());
    const apply = () => {
      observer.disconnect();
      markPassages(root, passages);
      if (lit.current) for (const m of root.querySelectorAll(`mark[data-comment="${CSS.escape(lit.current)}"]`)) m.setAttribute('data-lit', '');
      observer.observe(root, { childList: true, subtree: true, characterData: true });
    };
    apply();
    return () => observer.disconnect();
  }, [text, passages]);
  // Opened from Later: at the passage, marked, while it is still there, else at its heading.
  useEffect(() => {
    const root = markdown();
    const comment = comments.find((c) => c.id === focus);
    if (!focus || !root || text === null) return;
    lit.current = focus;
    const marks = root.querySelectorAll(`mark[data-comment="${CSS.escape(focus)}"]`);
    for (const m of marks) m.setAttribute('data-lit', '');
    const heading = comment?.ref.heading && [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].find((h) => h.textContent.trim() === comment.ref.heading);
    (marks[0] ?? heading)?.scrollIntoView({ block: marks[0] ? 'center' : 'start' });
    shownComment();
  }, [focus, text]);

  const startComment = () => {
    if (!picked) return;
    setWriting(picked);
    setPicked(null);
  };
  const closeNote = () => {
    setWriting(null);
    getSelection()?.removeAllRanges();
  };
  const sendComments = () => {
    const message = documentCommentsMessage(invocation, doc.path, comments);
    void hold(session, { action: 'answer', body: { key: null, text: message, drafts: comments.map((c) => c.id) }, label: message, command: true }, name, { box: false });
  };

  const detail = [doc.type ? TYPE_LABELS[doc.type] : null, doc.name, `changed ${ago(doc.modifiedAt)}`].filter(Boolean).join(' · ');
  return (
    <div className={styles.viewer}>
      <Header session={id} path={doc.path} title={doc.title ?? doc.name} detail={detail}>
        {comments.length > 0 && (
          <button
            type="button"
            className={styles.send}
            data-send-comments
            disabled={!!blocked}
            {...explain(blocked ? { does: blocked } : { ...SENDS.prompt(''), does: `Sends the comments on this document to Claude as one rpi command, with 5 s to undo: “${invocation} update ${doc.path}”, then each comment with its heading and the passage quoted. They leave Later once sent.` })}
            onClick={sendComments}
          >
            Send {plural(comments.length, 'comment')}
          </button>
        )}
      </Header>
      <div className={styles.scroll} ref={scroller} data-document-body onClick={follow}>
        {failed && text === null ? <p className={styles.empty}>This document could not be read.</p>
          : text !== null && <Markdown source={stripFrontMatter(text)} href={href} />}
        {picked && !writing && (
          <button
            type="button"
            className={styles.comment}
            style={{ top: picked.top, left: picked.left }}
            data-comment-button
            data-explain="Writes a comment on the selected passage, kept under Later; nothing is sent"
            onMouseDown={(e) => e.preventDefault()}
            onClick={startComment}
          >
            Comment
          </button>
        )}
        {writing && (
          <div className={styles.noteAt} style={{ top: writing.top }}>
            <CommentNote session={session} at={{ kind: 'document', path: doc.path, heading: writing.heading, quote: writing.quote }} onDone={closeNote} />
          </div>
        )}
      </div>
    </div>
  );
}

const stripFrontMatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '');

function FileView({ session, file, frame }: { session: string; file: SupportingFile; frame: RefObject<HTMLIFrameElement | null> }) {
  const src = `${documentUrl(session, file.path)}?v=${file.modifiedAt}`;
  return (
    <div className={styles.viewer}>
      <Header session={session} path={file.path} title={file.name} detail={`${file.kind === 'mockup' ? 'Mockup' : 'Image'} · changed ${ago(file.modifiedAt)}`} />
      {file.kind === 'mockup'
        ? <iframe ref={frame} key={src} className={styles.frame} data-explain={file.name} src={src} sandbox="allow-scripts" />
        : <div className={styles.scroll}><img className={styles.image} src={src} alt={file.name} /></div>}
    </div>
  );
}
