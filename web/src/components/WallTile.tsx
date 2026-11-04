import type { MouseEvent } from 'react';
import { openDecision } from '../../../server/decision.ts';
import { promptOf } from '../deck.ts';
import { openSheet, sessionPath } from '../router.ts';
import type { RepoView, Session } from '../types.ts';
import { useBusy } from '../sends.ts';
import { adviceFor, ago, attentionOf, decisionOf, locate, sessionLabel, shownOf, type Attention, type Shown } from '../util.ts';
import { Clock } from './Clock.tsx';
import { ParentCrumb } from './Findings.tsx';
import { ClearButton, SessionMenu } from './SessionMenu.tsx';
import { BranchMark } from './Parts.tsx';
import { StateMark } from './StateMark.tsx';
import { ERROR_LINES, hintOf, labelOf, PrChips, stoppedOnError } from './Status.tsx';
import styles from './WallTile.module.css';

function textOf(s: Session, attention: Attention) {
  if (attention === 'clearing') return 'Clear task is removing it; it leaves the board once its worktree is gone';
  if (s.clearError) return `Clear task did not finish: ${s.clearError}`;
  if (attention === 'decide') return decisionOf(s)?.problem ?? s.menu!.questions.map((q) => q.question).join(' · ');
  if (attention === 'focus') return promptOf(s).headline;
  if (stoppedOnError(s, attention)) return ERROR_LINES[s.turnError!.kind];
  return s.summary?.text || s.firstPrompt || 'Starting…';
}

// A subtask in one of these states wants you, and its task's tile says so.
const WANTS: Shown[] = ['decide', 'focus', 'idle'];
const rank = (s: Shown) => (WANTS.includes(s) ? WANTS.indexOf(s) : WANTS.length);

function adviceTag(s: Session) {
  const a = adviceFor(s);
  if (a?.state === 'done') return `Second opinion · ${a.confidence}%`;
  return a?.state === 'thinking' ? 'Second opinion running' : null;
}

// The whole tile opens the task's page, also for one waiting in the queue, whose page leads to its card; through a
// click on the article rather than a link stretched over it, which would sit above every label and hide its tooltip.
export function WallTile({ session, repos, unsettled }: { session: Session; repos: RepoView[]; unsettled: readonly Session[] }) {
  const { place, worktree, branch } = locate(repos, session);
  const name = sessionLabel(session, branch);
  const attention = attentionOf(session);
  const archived = session.archived;
  const busy = useBusy();
  const own = shownOf(session, busy);
  // A task that waits on its subtasks is in progress while any of them works.
  const shown = !archived && (own === 'idle' || own === 'exited') && unsettled.some((o) => !o.archived && shownOf(o, busy) === 'working') ? 'working' : own;
  const clearFailed = !!session.clearError && !session.clearing;
  const label = archived ? 'Archived' : clearFailed ? 'Clear failed' : session.interrupted?.cause === 'pause' && session.status !== 'working' ? 'Paused' : shown === 'exited' && session.interrupted ? 'Ended by restart' : labelOf(session, shown);
  const working = !archived && attention === 'working';
  const asked = attention === 'decide' ? openDecision(session)?.askedAt : undefined;
  const tag = shown === 'decide' && !archived ? adviceTag(session) : null;
  const wanting = unsettled.filter((o) => !o.archived && WANTS.includes(shownOf(o, busy))).sort((a, b) => WANTS.indexOf(shownOf(a, busy)) - WANTS.indexOf(shownOf(b, busy)));
  const restarted = unsettled.filter((o) => o.status === 'exited' && o.interrupted && o.interrupted.cause !== 'pause' && !o.archived);
  const wants = wanting.length && !archived && WANTS.indexOf(shownOf(wanting[0], busy)) < rank(shown) ? shownOf(wanting[0], busy) : undefined;

  const show = () => openSheet(session.id);
  const open = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('a, button, [popover]') || getSelection()?.toString()) return;
    show();
  };
  const follow = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    show();
  };

  return (
    <article
      className={styles.tile}
      data-tile
      data-session={session.id}
      data-attention={shown}
      data-archived={archived || undefined}
      data-wants={wants}
      aria-label={`${name}, ${label}`}
      onClick={open}
    >
      <header className={styles.head}>
        <StateMark state={archived ? 'archived' : shown} />
        <span className={styles.state} data-error={clearFailed || stoppedOnError(session, shown) || undefined} data-explain={archived ? undefined : hintOf(session, shown)}>{label}</span>
        <span className={styles.age} data-age data-explain={asked !== undefined ? undefined : session.summary ? 'When the status was last updated' : 'When the session last changed'}>
          {asked !== undefined ? `asked ${ago(asked)}` : ago(session.summary?.at ?? session.updatedAt)}
        </span>
        <span className={styles.menu}>
          <ClearButton session={session} />
          <SessionMenu session={session} worktree={worktree} name={name} />
        </span>
      </header>
      <ParentCrumb session={session} />
      <BranchMark session={session} branch={branch} />
      <a className={styles.name} href={sessionPath(session.id)} onClick={follow} data-ux="task">{name}</a>
      <p className={styles.text}>{textOf(session, attention)}</p>
      {restarted.length > 0 && (
        <ul className={styles.restarted} aria-label="Subtasks ended by restart">
          {restarted.map((o) => (
            <li key={o.id} data-restart-subtask={o.id}>
              <button type="button" data-ux="subtask" data-explain="Open this subtask; Resume all or Continue brings it back" onClick={() => openSheet(o.id)}>
                <span className={styles.restartedLabel}>Ended by restart</span>
                <span className={styles.restartedName}>{sessionLabel(o, locate(repos, o).branch)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {working && (
        <div className={styles.work}>
          <code>{session.activity?.step ?? 'Starting'}</code>
          {session.activity && <span className={styles.clock} data-explain="How long the turn has run"><Clock since={session.activity.since} /></span>}
        </div>
      )}
      {!archived && (
        <footer className={styles.foot}>
          <span className={styles.where}>{place} · {branch}</span>
          {tag && <span className={styles.tag}>{tag}</span>}
          {!!session.summary?.learnings?.length && <span className={styles.know} data-explain="Claude found something notable; open the task to read it">Worth knowing</span>}
          <PrChips prs={session.prs} status={session.status} />
        </footer>
      )}
    </article>
  );
}
