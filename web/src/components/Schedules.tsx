import { useState } from 'react';
import { api } from '../api.ts';
import { openSheet } from '../router.ts';
import { day, describeWhen } from '../schedules.ts';
import { useStore } from '../store.ts';
import type { Schedule } from '../types.ts';
import { Icon } from './Icon.tsx';
import styles from './Schedules.module.css';
import { toast, UNDO_KBD } from './Toasts.tsx';

function Row({ schedule: s }: { schedule: Schedule }) {
  const { repos, folders, sessions } = useStore();
  const [busy, setBusy] = useState(false);
  const where = s.task.kind === 'folder'
    ? folders.find((f) => f.path === (s.task as { folder: string }).folder)?.name ?? s.task.folder
    : repos.find((r) => r.id === (s.task as { repoId: number }).repoId)?.name ?? 'a removed repository';
  const mode = s.task.kind === 'repo' && s.task.existingBranch ? ` on ${s.task.branch}` : '';
  const ran = s.last?.sessionId ? sessions.find((x) => x.id === s.last!.sessionId) : undefined;

  const act = async (what: string, run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
    } catch (err) {
      toast('error', `Could not ${what} ${s.name}: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = () => act('delete', async () => {
    await api('DELETE', `/api/schedules/${s.id}`);
    toast('undo', `Deleted the schedule ${s.name}`, {
      action: { label: 'Undo', kbd: UNDO_KBD, run: () => void api('POST', '/api/schedules', { name: s.name, task: s.task, when: s.when }).catch((err) => toast('error', `Could not bring ${s.name} back: ${(err as Error).message}`)) },
    });
  });

  return (
    <li className={styles.row} data-schedule={s.name} data-paused={s.paused || undefined}>
      <div className={styles.what}>
        <strong>{s.name}</strong>
        <span>{where}{mode} · {describeWhen(s.when)}</span>
        <p className={styles.prompt} data-explain={s.task.prompt}>{s.task.prompt}</p>
      </div>
      <div className={styles.when}>
        <span data-next>{s.paused ? 'Paused' : s.next !== null ? `Next ${day(s.next)}` : 'Done'}</span>
        {s.last && (
          s.last.error ? <span className={styles.failed} data-last="failed" data-explain={s.last.error}>Failed {day(s.last.at)}: {s.last.error}</span>
            : ran ? <button type="button" className={styles.link} data-last="ran" onClick={() => openSheet(ran.id)}>Ran {day(s.last.at)}</button>
            : <span data-last="ran">Ran {day(s.last.at)}</span>
        )}
      </div>
      <div className={styles.actions}>
        <button type="button" disabled={busy} onClick={() => act('run', () => api<{ sessionId: string | null; error: string | null }>('POST', `/api/schedules/${s.id}/run`).then((r) => {
          if (r.error) toast('error', `${s.name} did not start: ${r.error}`);
          else if (r.sessionId) openSheet(r.sessionId);
        }))}>
          <Icon name="play" size={14} />Run now
        </button>
        {(s.next !== null || s.paused) && (
          <button type="button" disabled={busy} onClick={() => act(s.paused ? 'resume' : 'pause', () => api('PATCH', `/api/schedules/${s.id}`, { paused: !s.paused }))}>
            {s.paused ? 'Resume' : 'Pause'}
          </button>
        )}
        <button type="button" disabled={busy} aria-label={`Delete ${s.name}`} data-explain="Delete" onClick={remove}>
          <Icon name="trash" size={14} />
        </button>
      </div>
    </li>
  );
}

// The list sits under the tiles; the Wall's heading counts the schedules and leads down to it.
export function ScheduledLink() {
  const { schedules } = useStore();
  const next = Math.min(...schedules.flatMap((s) => (s.paused || s.next === null ? [] : [s.next])));
  return (
    <button type="button" className={styles.lead} data-scheduled-link onClick={() => document.querySelector('[data-schedules]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
      <Icon name="clock" size={14} />
      {schedules.length} scheduled{Number.isFinite(next) && `, next ${day(next)}`}
    </button>
  );
}

export function Schedules() {
  const { schedules } = useStore();
  if (!schedules.length) return null;
  return (
    <section className={styles.schedules} aria-label="Scheduled" data-schedules>
      <h2>Scheduled</h2>
      <ul>
        {schedules.map((s) => <Row key={s.id} schedule={s} />)}
      </ul>
    </section>
  );
}
