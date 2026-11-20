import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { TYPE_LABELS } from '../../../server/rpi.ts';
import { api } from '../api.ts';
import { SHEET_DIALOG } from '../keys.ts';
import { sessionPath, showTab } from '../router.ts';
import type { DocumentEntry, Session, SupportingFile, TaskFolder } from '../types.ts';
import { ago } from '../util.ts';
import styles from './Documents.module.css';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { documentItem, PhaseStrip } from './Workflow.tsx';

export const documentUrl = (session: string, path: string) => `/api/sessions/${session}/documents/${path.split('/').map(encodeURIComponent).join('/')}`;

// A path a document names, from the folder the document lies in; null for a link to another site or to the page itself.
function relativeTo(doc: string, to: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(to) || to.startsWith('#') || to.startsWith('/')) return null;
  const url = new URL(to, `file:///${doc}`);
  return decodeURIComponent(url.pathname.slice(1));
}

type Shown = { kind: 'document'; entry: DocumentEntry } | { kind: 'file'; entry: SupportingFile };

// The task's rpi documents, as they stand on disk: read when the tab opens and again whenever the snapshot's stamp
// says a file changed.
export function Documents({ session, item }: { session: Session; item: string | null }) {
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
        </div>
      )}
      <div className={styles.documents}>
        <nav className={styles.list} aria-label="Documents">
          {folders.map((f) => (
            <section key={f.path} aria-label={f.name}>
              {folders.length > 1 && <h3 className={styles.folder}>{f.name}</h3>}
              {f.documents.map((d) => (
                <button key={d.path} type="button" data-ux="document" data-document={d.path} aria-current={shown.entry.path === d.path || undefined} onClick={() => select(d.path)}>
                  <strong>{d.title ?? d.name}</strong>
                  <span>{d.type ? TYPE_LABELS[d.type] : 'Document'} · {ago(d.modifiedAt)}</span>
                </button>
              ))}
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
          ? <DocumentView key={shown.entry.path} session={session.id} doc={shown.entry} known={[...documents, ...files].map((d) => d.path).join('\n')} />
          : <FileView session={session.id} file={shown.entry} frame={frame} />}
      </div>
    </div>
  );
}

function Header({ session, path, title, detail }: { session: string; path: string; title: string; detail: string }) {
  return (
    <header>
      <strong>{title}</strong>
      <span>{detail}</span>
      <a href={documentUrl(session, path)} target="_blank" rel="noreferrer">
        Open in new tab <Icon name="external" size={14} />
      </a>
    </header>
  );
}

// Kept on screen while a newer version is read, so a change on disk redraws the document where you were reading.
// `known` lists the paths beside it, one a line, so the rewritten links stay the same, and the document is not drawn
// again, until a file comes or goes.
function DocumentView({ session, doc, known }: { session: string; doc: DocumentEntry; known: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(documentUrl(session, doc.path), { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))))
      .then((t) => {
        if (!live) return;
        setText(t);
        setFailed(false);
      }, () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [session, doc.path, doc.modifiedAt, doc.size]);

  const paths = useMemo(() => new Set(known.split('\n')), [known]);
  const href = useCallback((to: string, image: boolean) => {
    const path = relativeTo(doc.path, to);
    if (path === null) return image ? null : to;
    if (image || !paths.has(path)) return documentUrl(session, path);
    return sessionPath(session, 'documents', documentItem(path));
  }, [session, doc.path, paths]);
  // A link to another document or a mockup opens in the tab, in place of this entry; one to any other file beside
  // them in a tab of its own, never in the board's window.
  const follow = (e: MouseEvent<HTMLDivElement>) => {
    const to = (e.target as Element).closest('a')?.getAttribute('href');
    if (!to || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const tab = `${sessionPath(session, 'documents')}/`;
    if (to.startsWith(tab)) {
      e.preventDefault();
      showTab('documents', to.slice(tab.length));
    } else if (to.startsWith(documentUrl(session, ''))) {
      e.preventDefault();
      window.open(to, '_blank', 'noreferrer');
    }
  };
  const detail = [doc.type ? TYPE_LABELS[doc.type] : null, doc.name, `changed ${ago(doc.modifiedAt)}`].filter(Boolean).join(' · ');
  return (
    <div className={styles.viewer}>
      <Header session={session} path={doc.path} title={doc.title ?? doc.name} detail={detail} />
      <div className={styles.scroll} data-document-body onClick={follow}>
        {failed && text === null ? <p className={styles.empty}>This document could not be read.</p>
          : text !== null && <Markdown source={stripFrontMatter(text)} href={href} />}
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
