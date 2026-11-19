import { useEffect, useState } from 'react';
import { openSheet } from '../router.ts';
import { reloadNow, useStore, type Link } from '../store.ts';
import type { Session } from '../types.ts';
import { clock, locate, sessionLabel } from '../util.ts';
import { openBugReport } from './BugReportDialog.tsx';
import { Icon } from './Icon.tsx';
import { openNewTask } from './NewTaskForm.tsx';
import { pauseAll } from './RestartBanner.tsx';
import { ThemeMenu } from './ThemeMenu.tsx';
import styles from './TopBar.module.css';
import { Usage } from './Usage.tsx';
import { openRepos } from './WorkspaceDialog.tsx';
import { explain, SENDS } from './explain.ts';

const LINK_TEXT: Record<Link, string> = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…' };

function ConnectionPill({ link }: { link: Link }) {
  const [lostAt, setLostAt] = useState(0);
  useEffect(() => setLostAt(link === 'reconnecting' ? Date.now() : 0), [link]);
  const title = link === 'reconnecting' && lostAt
    ? `Lost the connection to Pitwall at ${clock(lostAt)}; what you see may be out of date. Answers you send wait and go out once it is back.`
    : undefined;
  return (
    <span className={styles.link} data-link={link} data-explain={title}>
      <span className={styles.dot} aria-hidden />
      <span className={styles.linkText}>{LINK_TEXT[link]}</span>
    </span>
  );
}

export interface Next {
  next: Session | null;
  count: number;
}

// The first task in the Wall's order that waits for a decision, but the one open now; absent when none waits.
export function NextDecision({ next: { next, count }, className }: { next: Next; className?: string }) {
  const { repos } = useStore();
  if (!next) return null;
  const name = sessionLabel(next, locate(repos, next).branch);
  return (
    <button type="button" className={className} data-next-decision data-ux="next decision" data-explain={`Open ${name}, the next task that waits for a decision (D)`} onClick={() => openSheet(next.id, 'overview')}>
      Next decision <span className={styles.count}>{count}</span> <kbd>D</kbd>
    </button>
  );
}

export function TopBar({ next }: { next: Next }) {
  const { repos, link, newVersion, pause } = useStore();
  return (
    <header className={styles.bar}>
      <div className={styles.start}>
        <span className={styles.wordmark} data-wordmark><img src="/icon.svg?v=4" alt="" width={26} height={26} /><span className={styles.name}>Pitwall</span></span>
        <ConnectionPill link={link} />
        {newVersion && link === 'live' && (
          <button type="button" className={styles.reload} data-new-version onClick={reloadNow}>
            New version · Reload
          </button>
        )}
      </div>
      <div className={styles.middle}>
        <NextDecision next={next} className={styles.next} />
      </div>
      <div className={styles.usage}><Usage /></div>
      <div className={styles.theme}><ThemeMenu /></div>
      <div className={styles.end}>
        {/* Pressing it leaves focus where it was, so the report shows the field that was being typed in. */}
        <button
          type="button"
          className={`${styles.ghost} ${styles.bug}`}
          data-bug-report
          aria-label="Bug report"
          data-explain="Bug report (B): say what went wrong, and a Pitwall task reproduces it, fixes it and delivers the fix"
          onMouseDown={(e) => e.preventDefault()}
          onClick={openBugReport}
        >
          <Icon name="bug" size={17} />
          <span className={styles.label}>Bug</span>
        </button>
        <button
          type="button"
          className={`${styles.ghost} ${styles.pause}`}
          data-pause
          aria-label="Pause"
          aria-pressed={pause.stopping.length > 0}
          {...explain(SENDS.pause)}
          onClick={() => void pauseAll()}
        >
          <Icon name="pause" size={17} />
          <span className={styles.label}>Pause</span>
        </button>
        <button type="button" className={styles.ghost} data-repos aria-label="Repos" onClick={openRepos}>
          <Icon name="folder" size={17} />
          <span className={styles.label}>Repos</span>
        </button>
        <button type="button" className={styles.newTask} disabled={!repos.length} aria-label="New task" onClick={() => openNewTask()}>
          <Icon name="plus" />
          <span className={styles.label}>New task</span>
        </button>
      </div>
    </header>
  );
}
