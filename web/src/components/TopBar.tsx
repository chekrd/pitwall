import { useEffect, useState } from 'react';
import { useQueue } from '../queue.ts';
import type { Route } from '../router.ts';
import { reloadNow, useStore, type Link } from '../store.ts';
import type { Session } from '../types.ts';
import { clock } from '../util.ts';
import { openBugReport } from './BugReportDialog.tsx';
import { Icon } from './Icon.tsx';
import { Meter } from './Meter.tsx';
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

export function TopBar({ route, deck }: { route: Route; deck: readonly Session[] }) {
  const { repos, link, newVersion, pause } = useStore();
  const { shown } = useQueue();
  const onQueue = route.view === 'queue';
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
        {deck.length > 0 && <Meter deck={deck} repos={repos} current={onQueue ? shown : null} />}
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
        <nav className={styles.toggle} aria-label="View">
          <a href="/" aria-current={onQueue ? 'page' : undefined} aria-label="Queue">
            <Icon name="queue" />
            <span className={styles.label}>Queue</span>
          </a>
          <a href="/wall" aria-current={onQueue ? undefined : 'page'} aria-label="Wall">
            <Icon name="wall" />
            <span className={styles.label}>Wall</span>
          </a>
        </nav>
        <button type="button" className={styles.newTask} disabled={!repos.length} aria-label="New task" onClick={() => openNewTask()}>
          <Icon name="plus" />
          <span className={styles.label}>New task</span>
        </button>
      </div>
    </header>
  );
}
