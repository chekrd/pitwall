import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { SHEET_DIALOG } from '../keys.ts';
import { closeSheet, openerOfTask, showTab, type Route, type Tab } from '../router.ts';
import { useStore } from '../store.ts';
import type { RepoView, Session, Upstream } from '../types.ts';
import { useBusy } from '../sends.ts';
import { locate, sessionLabel, shownOf } from '../util.ts';
import { artifactGroups, Artifacts } from './Artifacts.tsx';
import { Conversation } from './Conversation.tsx';
import { DiffView } from './DiffView.tsx';
import { Documents } from './Documents.tsx';
import { Icon } from './Icon.tsx';
import { Overview } from './Overview.tsx';
import { BranchMark } from './Parts.tsx';
import { ClearButton, SessionMenu } from './SessionMenu.tsx';
import { StateMark } from './StateMark.tsx';
import { hintOf, labelOf, PrChips, stoppedOnError } from './Status.tsx';
import { TaskName } from './TaskName.tsx';
import styles from './TaskSheet.module.css';
import { toast } from './Toasts.tsx';

// The task's own page follows the route: a task URL opens it over the Wall, and Esc, the back button or Back return
// to the Wall.
export function TaskSheet({ route }: { route: Route }) {
  const { sessions, repos, link } = useStore();
  const page = useRef<HTMLElement>(null);
  const sheet = route.sheet;
  const session = sheet ? sessions.find((s) => s.id === sheet.id) : undefined;
  const name = session ? sessionLabel(session, locate(repos, session).branch) : 'Task';
  const id = sheet?.id;
  const gone = !!sheet && link !== 'connecting' && !session;

  // Opening, the page takes focus itself, as the start of what it holds, rather than ringing its first button.
  useEffect(() => {
    if (id) page.current?.focus({ preventScroll: true });
  }, [id]);

  // Closing, focus goes back to what opened it, such as the tile's name; the view under it is no longer inert by then.
  const open = !!id;
  useLayoutEffect(() => {
    if (!open) return;
    const opener = openerOfTask();
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!gone) return;
    toast('info', 'That task is gone.');
    closeSheet();
  }, [gone]);

  if (!sheet) return null;
  return (
    <section id={SHEET_DIALOG} ref={page} tabIndex={-1} className={styles.page} data-session={id} aria-label={name}>
      {link === 'connecting' && <p className={styles.connecting}>Connecting…</p>}
      {session && <Body key={session.id} session={session} name={name} repos={repos} tab={sheet.tab} item={sheet.item} view={{ version: sheet.version, changes: sheet.changes }} />}
    </section>
  );
}

interface BodyProps {
  session: Session;
  name: string;
  repos: RepoView[];
  tab: Tab;
  item: string | null;
  view: { version: number | null; changes: boolean };
}

function Body({ session, name, repos, tab, item, view }: BodyProps) {
  const { repo, worktree, branch } = locate(repos, session);
  const attention = shownOf(session, useBusy());
  const stat = session.diffstat;
  const tabs: { key: Tab; label: string; kbd: string }[] = [
    { key: 'overview', label: 'Overview', kbd: '1' },
    { key: 'conversation', label: 'Conversation', kbd: '2' },
    { key: 'diff', label: 'Diff', kbd: '3' },
    ...(session.artifacts.length ? [{ key: 'artifacts' as const, label: `Artifacts (${artifactGroups(session.artifacts).length})`, kbd: '4' }] : []),
    ...(session.workflow ? [{ key: 'documents' as const, label: `Documents (${session.workflow.documents})`, kbd: '5' }] : []),
  ];
  const current = tabs.some((t) => t.key === tab) ? tab : 'overview';

  return (
    <>
      <header className={styles.head}>
        <button type="button" className={styles.close} aria-label="Back to the Wall" onClick={closeSheet}>
          <Icon name="arrow-left" size={18} />
          <span>Wall</span>
          <kbd>Esc</kbd>
        </button>
        <div className={styles.heading}>
          <BranchMark session={session} branch={branch} />
          <TaskName session={session} name={name} />
          <span className={styles.state} data-attention={session.archived ? 'archived' : attention} data-error={stoppedOnError(session, attention) || undefined} data-explain={session.archived ? undefined : hintOf(session, attention)}>
            <StateMark state={session.archived ? 'archived' : attention} size={8} />
            {session.archived ? 'Archived' : labelOf(session, attention)}
          </span>
          <PrChips prs={session.prs} status={session.status} />
          {session.repoId !== null && <UpstreamMark session={session} diffOpen={current === 'diff'} />}
        </div>
        <nav className={styles.tabs} role="tablist" aria-label="Task">
          {tabs.map((t) => (
            t.key === 'diff' && stat ? (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={t.key === current}
                data-changes={stat.files > 0 || undefined}
                data-ux="Diff"
                data-explain={stat.files ? 'Has changes against the base branch' : 'No changes against the base branch'}
                onClick={() => showTab(t.key)}
              >
                {t.label}{stat.files > 0 && <span className={styles.changes} aria-label="has changes" />} <kbd>{t.kbd}</kbd>
              </button>
            ) : (
              <button key={t.key} type="button" role="tab" aria-selected={t.key === current} onClick={() => showTab(t.key)}>
                {t.label} <kbd>{t.kbd}</kbd>
              </button>
            )
          ))}
        </nav>
        <span className={styles.actions}>
          <ClearButton session={session} />
          <SessionMenu session={session} worktree={worktree} name={name} />
        </span>
      </header>
      <div className={styles.panel} role="tabpanel">
        {current === 'overview' && <Overview session={session} name={name} branch={worktree?.branch ?? undefined} repo={repo} />}
        {current === 'diff' && <DiffView session={session} at={item} />}
        {current === 'artifacts' && <Artifacts session={session} item={item} changes={view.changes} />}
        {current === 'conversation' && <Conversation session={session} />}
        {current === 'documents' && <Documents session={session} name={name} item={item} view={view} />}
      </div>
    </>
  );
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

// A pull request's own list of changed files, on GitHub and Azure DevOps.
const prFilesUrl = (url: string) => (url.includes('/_git/') ? `${url}?_a=files` : `${url}/files`);

// Marks commits only the origin branch has, as when someone else pushed or rewrote it; read when the page opens and again when the Diff does.
function UpstreamMark({ session, diffOpen }: { session: Session; diffOpen: boolean }) {
  const [up, setUp] = useState<Upstream | null>(null);
  useEffect(() => {
    if (!diffOpen && up) return;
    let live = true;
    api('GET', `/api/upstream?worktree=${encodeURIComponent(session.worktree)}`)
      .then((next) => live && setUp(next), () => {});
    return () => {
      live = false;
    };
  }, [session.worktree, diffOpen]);
  if (!up?.behind) return null;
  const pr = session.prs.findLast((p) => p.url && p.repo === null);
  const local = session.diffstat ? `, this checkout ${plural(session.diffstat.files, 'file')}` : '';
  const explain = [
    up.state === 'diverged'
      ? `${up.upstream} was rewritten, as by a force-push: this checkout's ${plural(up.ahead, 'commit')} are no longer on it. ${pr ? 'The PR' : 'It'} has ${plural(up.branchFiles ?? 0, 'file')}${local}; the Diff shows this checkout.`
      : `${up.upstream} has ${plural(up.behind, 'commit')} this checkout does not, changing ${plural(up.behindFiles, 'file')}.`,
    up.fetchFailed && `Fetching ${up.upstream} failed, so this is as of the last fetch.`,
    pr?.url && 'Opens the PR\'s changed files.',
  ].filter(Boolean).join('\n');
  const marks = { className: styles.upstream, 'data-upstream': up.state, 'data-explain': explain, 'aria-label': `${up.upstream} has changes this checkout does not` };
  const text = <>↓ origin</>;
  return pr?.url
    ? <a {...marks} href={prFilesUrl(pr.url)} target="_blank" rel="noreferrer" data-ux="pr-files">{text}</a>
    : <span {...marks}>{text}</span>;
}
