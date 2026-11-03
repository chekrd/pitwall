import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { SHEET_DIALOG } from '../keys.ts';
import { closeSheet, openerOfTask, showTab, type Route, type Tab } from '../router.ts';
import { useStore } from '../store.ts';
import type { RepoView, Session, Upstream } from '../types.ts';
import { useBusy } from '../sends.ts';
import { descendantsOf, locate, openSubtasks, sessionLabel, shownOf } from '../util.ts';
import { Artifacts } from './Artifacts.tsx';
import { Conversation } from './Conversation.tsx';
import { DiffView } from './DiffView.tsx';
import { ParentCrumb, stateLabel } from './Findings.tsx';
import { Icon } from './Icon.tsx';
import { Overview } from './Overview.tsx';
import { BranchMark } from './Parts.tsx';
import { ClearButton, SessionMenu } from './SessionMenu.tsx';
import { StateMark } from './StateMark.tsx';
import { hintOf, PrChips, stoppedOnError } from './Status.tsx';
import { TaskName } from './TaskName.tsx';
import styles from './TaskSheet.module.css';
import { toast } from './Toasts.tsx';

// The task's own page follows the route: a task URL opens it over the whole view, and Esc, the back button or Back
// return to the view it was opened from.
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
      {session && <Body key={session.id} session={session} name={name} repos={repos} tab={sheet.tab} item={sheet.item} back={route.view} />}
    </section>
  );
}

interface BodyProps {
  session: Session;
  name: string;
  repos: RepoView[];
  tab: Tab;
  item: string | null;
  back: Route['view'];
}

function Body({ session, name, repos, tab, item, back }: BodyProps) {
  const { repo, worktree, branch } = locate(repos, session);
  const attention = shownOf(session, useBusy());
  const { sessions } = useStore();
  const { open, total } = openSubtasks(sessions, session.id);
  const stat = session.diffstat;
  const tabs: { key: Tab; label: string; kbd: string }[] = [
    { key: 'overview', label: 'Overview', kbd: '1' },
    { key: 'conversation', label: 'Conversation', kbd: '2' },
    { key: 'diff', label: 'Diff', kbd: '3' },
    ...(session.artifacts.length ? [{ key: 'artifacts' as const, label: `Artifacts (${session.artifacts.length})`, kbd: '4' }] : []),
  ];
  const current = tabs.some((t) => t.key === tab) ? tab : 'overview';

  return (
    <>
      <header className={styles.head}>
        <button type="button" className={styles.close} aria-label={back === 'wall' ? 'Back to the Wall' : 'Back to the queue'} onClick={closeSheet}>
          <Icon name="arrow-left" size={18} />
          <span>{back === 'wall' ? 'Wall' : 'Queue'}</span>
          <kbd>Esc</kbd>
        </button>
        <div className={styles.heading} data-subtask={!!session.parent || undefined}>
          {session.parent && <div className={styles.crumb}><ParentCrumb session={session} /></div>}
          <BranchMark session={session} branch={branch} />
          <TaskName session={session} name={name} />
          <span className={styles.state} data-attention={session.archived ? 'archived' : attention} data-resolution={session.resolution?.state} data-error={stoppedOnError(session, attention) || undefined} data-explain={session.archived ? undefined : hintOf(session, attention)}>
            <StateMark state={session.archived ? 'archived' : attention} size={8} />
            {stateLabel(session, attention)}
          </span>
          {total > 0 && (
            <span className={styles.open} data-open-count data-settled={!open.length || undefined} data-explain={subtasksExplained(sessions, repos, session.id, open)}>
              {open.length ? `${open.length} of ${total} ${total === 1 ? 'subtask' : 'subtasks'} open` : <><Icon name="check" size={13} />{total === 1 ? 'Subtask' : `All ${total} subtasks`} solved or dropped</>}
            </span>
          )}
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
                data-changes={stat.files || undefined}
                data-ux="Diff"
                data-explain={stat.files ? `${stat.files} ${stat.files === 1 ? 'file' : 'files'} changed: +${stat.insertions} −${stat.deletions}` : 'No changes against the base branch'}
                onClick={() => showTab(t.key)}
              >
                {t.label} {stat.files > 0 ? <span className={styles.changes}>{stat.files}</span> : <span className={styles.clean}>none</span>} <kbd>{t.kbd}</kbd>
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
        {current === 'diff' && <DiffView worktree={session.worktree} />}
        {current === 'artifacts' && <Artifacts session={session} item={item} />}
        {current === 'conversation' && <Conversation session={session} />}
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
    api<Upstream | null>('GET', `/api/upstream?worktree=${encodeURIComponent(session.worktree)}`)
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

function subtasksExplained(sessions: readonly Session[], repos: RepoView[], id: string, open: readonly Session[]) {
  const label = (o: Session) => `“${sessionLabel(o, locate(repos, o).branch)}”`;
  const all = descendantsOf(sessions, id).map((d) => d.session);
  const by = (state: string) => all.filter((o) => o.resolution?.state === state).map(label);
  const groups: [string, string[]][] = [['Still open', open.map(label)], ['Solved', by('solved')], ['Dropped', by('dropped')]];
  return groups.filter(([, names]) => names.length).map(([what, names]) => `${what}: ${names.join(', ')}.`).join(' ');
}
