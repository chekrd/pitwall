import { orderTiles, waitingLabel } from '../order.ts';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { useStore } from '../store.ts';
import type { Session } from '../types.ts';
import { attentionOf } from '../util.ts';
import { Icon } from './Icon.tsx';
import styles from './Wall.module.css';
import { WallTile } from './WallTile.tsx';
import { ScheduledLink, Schedules } from './Schedules.tsx';

export function Wall({ waiting }: { waiting: readonly Session[] }) {
  const { repos, sessions, schedules, link } = useStore();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  if (link === 'connecting') {
    return (
      <main className={styles.wall}>
        <p className={styles.connecting}>Connecting…</p>
      </main>
    );
  }
  const { active, archived } = orderTiles(sessions);
  const working = sessions.filter((s) => !s.archived && attentionOf(s) === 'working').length;
  const title = !sessions.length ? (repos.length ? 'Ready when you are.' : 'Welcome to Pitwall.') : waiting.length ? 'Every agent, in the order they need you' : 'All caught up.';
  const sub = !sessions.length ? null
    : waiting.length ? `${waitingLabel(waiting)} ${waiting.length === 1 ? 'waits' : 'wait'} for you.`
    : working ? `${working} ${working === 1 ? 'agent is' : 'agents are'} on it.`
    : 'A good moment to start something new.';

  return (
    <main className={styles.wall} data-resting={(!!sessions.length && !waiting.length) || undefined}>
      <header className={styles.head}>
        <div className={styles.titles}>
          <h1>{title}</h1>
          {sub && <p>{sub}</p>}
          {schedules.length > 0 && <ScheduledLink open={() => flushSync(() => setScheduledOpen(true))} />}
        </div>
      </header>
      {!active.length && (
        <div className={styles.empty}>
          <Icon name="queue" size={44} stroke={1.4} />
          <p>{repos.length ? 'Start one with New task.' : 'Add a repository or a folder of repositories under Repos to begin.'}</p>
        </div>
      )}
      <div className={styles.tiles}>
        {active.map((s) => <WallTile key={s.id} session={s} repos={repos} />)}
      </div>
      {schedules.length > 0 && (
        <details className={styles.fold} data-schedules open={scheduledOpen} onToggle={(e) => setScheduledOpen(e.currentTarget.open)}>
          <summary><Icon name="chevron-right" size={14} />Scheduled ({schedules.length})</summary>
          {scheduledOpen && <Schedules />}
        </details>
      )}
      {archived.length > 0 && (
        <details className={styles.fold} open={archivedOpen} onToggle={(e) => setArchivedOpen(e.currentTarget.open)}>
          <summary><Icon name="chevron-right" size={14} />Archived ({archived.length})</summary>
          <div className={styles.tiles}>
            {archivedOpen && archived.map((s) => <WallTile key={s.id} session={s} repos={repos} />)}
          </div>
        </details>
      )}
    </main>
  );
}
