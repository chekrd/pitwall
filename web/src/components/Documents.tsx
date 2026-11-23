import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { documentCommentsMessage } from '../../../server/codeRef.ts';
import { byCycle, currentVersion, firstOutdated, laterUnderWay, outdatedBy, PHASE_LABELS, reworkStep, TYPE_LABELS, type Phase, type VersionState } from '../../../server/rpi.ts';
import { rpiInvocation } from '../../../server/slash.ts';
import { api, sessionAction } from '../api.ts';
import { SHEET_DIALOG } from '../keys.ts';
import { changedSince, markRead, useReadVersions } from '../readVersions.ts';
import { sessionPath, showTab, type View } from '../router.ts';
import { hold } from '../sends.ts';
import type { DocComment, DocumentEntry, Session, SupportingFile, TaskFolder, Workflow } from '../types.ts';
import { ago } from '../util.ts';
import { Changes, VersionPicker } from './Changes.tsx';
import { CommentNote, CommentsPanel, fileName, markPassages, pickedIn, plural, useComments, type Marked, type Picked } from './Comments.tsx';
import { useCommands } from './Composer.tsx';
import styles from './Documents.module.css';
import { explain, SENDS } from './explain.ts';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { PhaseSteps, sendBlocked, sendStep, stepTip } from './PhaseSteps.tsx';
import { toast } from './Toasts.tsx';
import { RpiGuideButton } from './RpiGuide.tsx';
import { documentItem, PhaseStrip } from './Workflow.tsx';

export const documentUrl = (session: string, path: string) => `/api/sessions/${session}/documents/${path.split('/').map(encodeURIComponent).join('/')}`;

export const versionUrl = (session: string, path: string, n: number) => `/api/sessions/${session}/versions/${n}?path=${encodeURIComponent(path)}`;

// A path a document names, from the folder the document lies in; null for a link to another site or to the page itself.
function relativeTo(doc: string, to: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(to) || to.startsWith('#') || to.startsWith('/')) return null;
  const url = new URL(to, `file:///${doc}`);
  return decodeURIComponent(url.pathname.slice(1));
}

type Shown = { kind: 'document'; entry: DocumentEntry } | { kind: 'file'; entry: SupportingFile };

// The task's rpi documents, as they stand on disk: read when the tab opens and again whenever the snapshot's stamp
// says a file changed.
export function Documents({ session, name, item, view }: { session: Session; name: string; item: string | null; view: View }) {
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
  const readOf = useReadVersions(session.id);

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

  const versionOf = (path: string) => workflow?.versions?.[path] ?? null;
  const changed = (path: string) => !!versionOf(path) && changedSince(readOf(path), currentVersion(versionOf(path)));
  // One that changed since you last read it opens at what changed.
  const select = (path: string) => showTab('documents', documentItem(path), { changes: changed(path) || undefined });
  const { current, earlier } = byCycle(folders, workflow?.folder);
  const section = (f: TaskFolder, heading: boolean) => (
    <section key={f.path} aria-label={f.name} data-folder={f.path}>
      {heading && <h3 className={styles.folder}>{f.name}</h3>}
      {f.documents.map((d) => {
        const count = comments.open.filter((c) => c.path === d.path).length;
        const version = currentVersion(versionOf(d.path));
        return (
          <button key={d.path} type="button" data-ux="document" data-document={d.path} aria-current={shown.entry.path === d.path || undefined} onClick={() => select(d.path)}>
            <strong>{d.title ?? d.name}</strong>
            <span>{d.type ? TYPE_LABELS[d.type] : 'Document'} · {ago(d.modifiedAt)}{version > 1 && <> · <span data-version-count>v{version}</span></>}</span>
            {changed(d.path) && <span className={styles.changed} data-changed data-explain={`v${version} came after you last read it, at v${readOf(d.path)}; opening it shows what changed`}>Changed since you read it</span>}
            {count > 0 && <span className={styles.count} data-comment-count data-explain="Comments on it that Claude has not had yet">{plural(count, 'comment')}</span>}
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
  );
  return (
    <div className={styles.page}>
      {workflow && (
        <div className={styles.strip}>
          <PhaseStrip session={session.id} workflow={workflow} outdated={session.review.outdated} />
          <RpiGuideButton workflow={workflow} model={session.model} />
          <PhaseSteps session={session} name={name} workflow={workflow} place="documents" />
        </div>
      )}
      <div className={styles.documents}>
        <nav className={styles.list} aria-label="Documents">
          {current.map((f) => section(f, folders.length > 1))}
          {earlier.length > 0 && (
            <details className={styles.earlier} data-earlier-cycles open={earlier.some((f) => holds(f, shown.entry.path)) || undefined}>
              <summary data-explain="The documents of the task's earlier rpi cycles, each in its own folder; the phase strip and the next steps follow the current one">Earlier cycles · {earlier.length}</summary>
              {earlier.map((f) => section(f, true))}
            </details>
          )}
        </nav>
        {shown.kind === 'document'
          ? (
            <DocumentView
              key={shown.entry.path}
              session={session}
              name={name}
              doc={shown.entry}
              known={[...documents, ...files].map((d) => d.path).join('\n')}
              open={comments.open.filter((c) => c.path === shown.entry.path)}
              sent={comments.sent.filter((c) => c.path === shown.entry.path)}
              archived={comments.archived.filter((c) => c.path === shown.entry.path)}
              titleOf={(path) => documents.find((d) => d.path === path)?.title ?? fileName(path)}
              versions={versionOf(shown.entry.path)}
              view={view}
              blocked={sendBlocked(session, commands)}
              invocation={rpiInvocation(commands ?? [])}
            />
          )
          : <FileView session={session.id} file={shown.entry} frame={frame} />}
      </div>
    </div>
  );
}

function Header({ href, title, detail, children }: { href: string; title: string; detail: string; children?: ReactNode }) {
  return (
    <header>
      <strong>{title}</strong>
      <span>{detail}</span>
      {children}
      <a href={href} target="_blank" rel="noreferrer">
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
  open: DocComment[];
  sent: DocComment[];
  archived: DocComment[];
  titleOf: (path: string) => string;
  blocked: string | null;
  invocation: string;
  versions: VersionState | null;
  view: View;
}

const NEW = 'new';

// Kept on screen while a newer version is read, so a change on disk redraws the document where you were reading.
// `known` lists the paths beside it, one a line, so the rewritten links stay the same, and the document is not drawn
// again, until a file comes or goes. A passage selected in it takes a comment, and the passages commented are marked
// in whichever version is shown that still has them.
function DocumentView({ session, name, doc, known, open, sent, archived, titleOf, blocked, invocation, versions, view }: ViewProps) {
  const id = session.id;
  const latest = currentVersion(versions);
  const shownVersion = view.version && view.version < latest ? view.version : latest;
  const old = shownVersion < latest;
  const showing = !!view.changes && shownVersion > 1;
  const source = old ? versionUrl(id, doc.path, shownVersion) : documentUrl(id, doc.path);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!old && versions) markRead(id, doc.path, latest);
  }, [id, doc.path, old, showing]);
  useEffect(() => {
    let live = true;
    fetch(source, { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))))
      .then((t) => {
        if (!live) return;
        setText(t);
        setFailed(false);
      }, () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [source, doc.modifiedAt, doc.size]);

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

  // The snapshot brings new comment objects on every change of the task, which would mark the document again each time.
  const commented = JSON.stringify(open.map((c) => [c.id, c.quote, c.text]));
  const passages = useMemo<Marked[]>(() => [
    ...open.flatMap((c) => (c.quote === null ? [] : [{ id: c.id, quote: c.quote, note: c.text }])),
    ...(writing ? [{ id: NEW, quote: writing.quote, note: '' }] : []),
  ], [commented, writing]);
  const lit = useRef<string | null>(null);
  const [litId, setLitId] = useState<string | null>(null);
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
  // A comment picked in the panel lights its passage and scrolls to it while it is in the version shown, else to its
  // heading.
  const showComment = (c: DocComment) => {
    const root = markdown();
    lit.current = c.id;
    setLitId(c.id);
    if (!root) return;
    for (const m of root.querySelectorAll('mark[data-lit]')) m.removeAttribute('data-lit');
    const marks = root.querySelectorAll(`mark[data-comment="${CSS.escape(c.id)}"]`);
    for (const m of marks) m.setAttribute('data-lit', '');
    const heading = c.heading && [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].find((h) => h.textContent.trim() === c.heading);
    const to = marks[0] ?? heading;
    if (to) to.scrollIntoView({ block: marks[0] ? 'center' : 'start' });
    else toast('info', `The passage is not in v${shownVersion} of ${doc.title ?? doc.name}`, { session: id });
  };

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
    const message = documentCommentsMessage(invocation, doc.path, open, latest);
    void hold(session, { action: 'answer', body: { key: null, text: message, comments: open.map((c) => c.id) }, label: message, command: true }, name, { box: false });
  };
  const workflow = session.workflow ?? null;
  const pick = (n: number) => showTab('documents', documentItem(doc.path), { version: n < latest ? n : undefined, changes: showing || undefined });

  const detail = [doc.type ? TYPE_LABELS[doc.type] : null, doc.name, old ? `v${shownVersion}, an older version` : `v${latest} · changed ${ago(doc.modifiedAt)}`].filter(Boolean).join(' · ');
  return (
    <div className={styles.viewer} data-shown-version={shownVersion}>
      <Header href={source} title={doc.title ?? doc.name} detail={detail}>
        {latest > 1 && (
          <span className={styles.versioning}>
            <VersionPicker versions={Array.from({ length: latest }, (_, i) => i + 1)} shown={shownVersion} onPick={pick} />
            {shownVersion > 1 && (
              <button
                type="button"
                className={styles.tool}
                aria-pressed={showing}
                data-show-changes
                data-explain={showing ? 'Shows the document again' : `Shows what changed in v${shownVersion} from v${shownVersion - 1}`}
                onClick={() => showTab('documents', documentItem(doc.path), { version: old ? shownVersion : undefined, changes: showing ? undefined : true })}
              >
                Changes
              </button>
            )}
          </span>
        )}
        {workflow && <ReworkLater session={session} name={name} workflow={workflow} path={doc.path} blocked={blocked} invocation={invocation} />}
      </Header>
      {workflow && <OutdatedBanner session={session} name={name} workflow={workflow} path={doc.path} titleOf={titleOf} blocked={blocked} invocation={invocation} />}
      <div className={styles.reading}>
        {showing ? (
          <Changes
            key={`${shownVersion}`}
            before={versionUrl(id, doc.path, shownVersion - 1)}
            after={source}
            name={doc.name}
            from={shownVersion - 1}
            to={shownVersion}
            stamp={old ? undefined : `${doc.modifiedAt}:${doc.size}`}
          />
        ) : <div className={styles.scroll} ref={scroller} data-document-body onClick={follow}>
          {failed && text === null ? <p className={styles.empty}>This document could not be read.</p>
            : text !== null && <Markdown source={stripFrontMatter(text)} href={href} />}
          {picked && !writing && (
            <button
              type="button"
              className={styles.comment}
              style={{ top: picked.top, left: picked.left }}
              data-comment-button
              data-explain="Writes a comment on the selected passage; nothing is sent until you send the document's comments"
              onMouseDown={(e) => e.preventDefault()}
              onClick={startComment}
            >
              Comment
            </button>
          )}
          {writing && (
            <div className={styles.noteAt} style={{ top: writing.top }}>
              <CommentNote session={session} at={{ path: doc.path, heading: writing.heading, quote: writing.quote, version: shownVersion }} onDone={closeNote} />
            </div>
          )}
        </div>}
        <CommentsPanel
          session={session}
          path={doc.path}
          version={shownVersion}
          latest={latest}
          open={open}
          sent={sent}
          archived={archived}
          lit={litId}
          onShow={showComment}
          onSend={sendComments}
          blocked={blocked}
          sendTip={{ ...SENDS.prompt(''), does: `Sends the comments on this document to Claude as one rpi command, with 5 s to undo: “${invocation} update ${doc.path}”, then each comment with its heading and the passage quoted, or as about the whole document. They move under Sent once sent.` }}
        />
      </div>
    </div>
  );
}

// The phase `path` is the newest document of, which a change to it can leave outdated, or that it can outdate.
const phaseOfDocument = (workflow: Workflow, path: string): Phase | null => workflow.steps.find((s) => s.phase !== 'implement' && s.document === path)?.phase ?? null;

const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

interface ReworkProps {
  session: Session;
  name: string;
  workflow: Workflow;
  path: string;
  blocked: string | null;
  invocation: string;
}

// On a document whose later phases are under way: marks them outdated, then sends the rework of the first, so a change
// made here reaches what was built on it. Nothing is marked while a send could not go.
function ReworkLater({ session, name, workflow, path, blocked, invocation }: ReworkProps) {
  const later = laterUnderWay(workflow, path);
  if (!later.length) return null;
  const labels = list(later.map((p) => PHASE_LABELS[p]));
  const rework = async () => {
    const outdated = { ...session.review.outdated, ...outdatedBy(workflow, path, Date.now()) };
    const marked = await sessionAction(session.id, 'mark-outdated', { because: path }).then(() => true, (err: unknown) => {
      toast('error', err instanceof Error ? err.message : String(err), { session: session.id });
      return false;
    });
    const first = firstOutdated(workflow, outdated);
    const step = marked && first && reworkStep(workflow, outdated, first, invocation);
    if (step) sendStep(session, name, step);
  };
  return (
    <button
      type="button"
      className={styles.send}
      data-rework-later
      disabled={!!blocked}
      {...explain(blocked ? { does: blocked } : {
        ...SENDS.prompt(''),
        does: `Marks ${labels} outdated, as written before this document changed, then sends the rework of the first, with 5 s to undo: /clear, then rpi's update of it. Each next one is the next step once the one before is done.`,
      })}
      onClick={() => void rework()}
    >
      Rework later phases
    </button>
  );
}

// On an outdated document: what changed before it, with its rework, or Keep as is, which takes the mark off.
function OutdatedBanner({ session, name, workflow, path, titleOf, blocked, invocation }: ReworkProps & { titleOf: (path: string) => string }) {
  const phase = phaseOfDocument(workflow, path);
  const outdated = session.review.outdated;
  const mark = phase && outdated[phase];
  if (!phase || !mark) return null;
  const step = reworkStep(workflow, outdated, phase, invocation);
  const keep = () => void sessionAction(session.id, 'keep-outdated', { phase }).catch((err: unknown) => toast('error', err instanceof Error ? err.message : String(err), { session: session.id }));
  return (
    <div className={styles.outdated} role="status" data-outdated-banner>
      <span>Outdated: <strong>{titleOf(mark.because)}</strong> changed after this was written.</span>
      <span className={styles.spacer} />
      {step && (
        <button type="button" data-variant="primary" data-rework-now disabled={!!blocked} {...explain(blocked ? { does: blocked } : stepTip(step))} onClick={() => sendStep(session, name, step)}>
          Rework now
        </button>
      )}
      <button type="button" data-keep-outdated data-explain="Takes the mark off: this document stands as it is" onClick={keep}>Keep as is</button>
    </div>
  );
}

const holds = (f: TaskFolder, path: string) => f.documents.some((d) => d.path === path) || f.files.some((d) => d.path === path);

const stripFrontMatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '');

function FileView({ session, file, frame }: { session: string; file: SupportingFile; frame: RefObject<HTMLIFrameElement | null> }) {
  const src = `${documentUrl(session, file.path)}?v=${file.modifiedAt}`;
  return (
    <div className={styles.viewer}>
      <Header href={documentUrl(session, file.path)} title={file.name} detail={`${file.kind === 'mockup' ? 'Mockup' : 'Image'} · changed ${ago(file.modifiedAt)}`} />
      {file.kind === 'mockup'
        ? <iframe ref={frame} key={src} className={styles.frame} data-explain={file.name} src={src} sandbox="allow-scripts" />
        : <div className={styles.scroll}><img className={styles.image} src={src} alt={file.name} /></div>}
    </div>
  );
}
