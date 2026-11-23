import type { MouseEvent } from 'react';
import { openDecision } from '../../../server/decision.ts';
import { roundTitle } from '../../../server/rounds.ts';
import { promptOf } from '../answers.ts';
import { openSheet, sessionPath } from '../router.ts';
import type { RepoView, Session } from '../types.ts';
import { useBusy } from '../sends.ts';
import { ago, attentionOf, decisionOf, locate, sessionLabel, shownOf, type Attention } from '../util.ts';
import { Clock } from './Clock.tsx';
import { ClearButton, SessionMenu } from './SessionMenu.tsx';
import { BranchMark } from './Parts.tsx';
import { StateMark } from './StateMark.tsx';
import { ERROR_LINES, failedToStart, hintOf, labelOf, PrChips, stoppedOnError } from './Status.tsx';
import { PhaseChip } from './Workflow.tsx';
import styles from './WallTile.module.css';

function textOf(s: Session, attention: Attention) {
  if (attention === 'clearing') return 'Clear task is removing it; it leaves the board once its worktree is gone';
  if (s.clearError) return `Clear task did not finish: ${s.clearError}`;
  if (failedToStart(s)) return s.starting!.error;
  if (attention === 'decide') return decisionOf(s)?.problem ?? s.menu?.questions.map((q) => q.question).join(' · ') ?? roundTitle(s.round!);
  if (attention === 'focus') return promptOf(s).headline;
  if (stoppedOnError(s, attention)) return ERROR_LINES[s.turnError!.kind];
  return s.firstPrompt || 'Starting…';
}

// The whole tile opens the task's page, where a decision is answered, through a click on the article rather than a
// link stretched over it, which would sit above every label and hide its tooltip.
export function WallTile({ session, repos }: { session: Session; repos: RepoView[] }) {
  const { place, worktree, branch } = locate(repos, session);
  const name = sessionLabel(session, branch);
  const attention = attentionOf(session);
  const archived = session.archived;
  const busy = useBusy();
  const shown = shownOf(session, busy);
  const clearFailed = !!session.clearError && !session.clearing;
  const label = archived ? 'Archived' : clearFailed ? 'Clear failed' : session.interrupted?.cause === 'pause' && session.status !== 'working' ? 'Paused' : shown === 'exited' && session.interrupted ? 'Ended by restart' : labelOf(session, shown);
  const working = !archived && attention === 'working';
  const asked = attention === 'decide' ? openDecision(session)?.askedAt : undefined;

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
      aria-label={`${name}, ${label}`}
      onClick={open}
    >
      <header className={styles.head}>
        <StateMark state={archived ? 'archived' : shown} />
        <span className={styles.state} data-error={clearFailed || failedToStart(session) || stoppedOnError(session, shown) || undefined} data-explain={archived ? undefined : hintOf(session, shown)}>{label}</span>
        <span className={styles.age} data-age data-explain={asked !== undefined ? undefined : 'When the session last changed'}>
          {asked !== undefined ? `asked ${ago(asked)}` : ago(session.updatedAt)}
        </span>
        <span className={styles.menu}>
          <ClearButton session={session} />
          <SessionMenu session={session} worktree={worktree} name={name} />
        </span>
      </header>
      <BranchMark session={session} branch={branch} />
      <a className={styles.name} href={sessionPath(session.id)} onClick={follow} data-ux="task">{name}</a>
      <p className={styles.text}>{textOf(session, attention)}</p>
      {working && (
        <div className={styles.work}>
          <code>{session.activity?.step ?? 'Starting'}</code>
          {session.activity && <span className={styles.clock} data-explain="How long the turn has run"><Clock since={session.activity.since} /></span>}
        </div>
      )}
      {!archived && (
        <footer className={styles.foot}>
          <span className={styles.where}>{place} · {branch}</span>
          {session.parked.length > 0 && (
            <span className={styles.later} data-later-count data-explain="Drafts you kept for later, under Later on the task's Overview">Later {session.parked.length}</span>
          )}
          {session.workflow && <PhaseChip workflow={session.workflow} outdated={session.review.outdated} />}
          <PrChips prs={session.prs} status={session.status} />
        </footer>
      )}
    </article>
  );
}
