import { useState } from 'react';
import { api } from '../api.ts';
import { openSheet } from '../router.ts';
import { useStore } from '../store.ts';
import type { Session } from '../types.ts';
import { ancestorsOf, attentionOf, locate, sessionLabel, type Shown } from '../util.ts';
import { Clock } from './Clock.tsx';
import styles from './RestartBanner.module.css';
import { STATE_LABELS } from './Status.tsx';
import { toast } from './Toasts.tsx';

// What the task showed when the restart killed its Claude: a decision and a finished turn both leave it idle.
export function interruptedAs(s: Session) {
  const i = s.interrupted!;
  return attentionOf({ ...s, status: i.status, waitingFor: i.waitingFor, menu: i.menu });
}

export const cutShort = (s: Session) => !!s.interrupted && s.interrupted.cause !== 'pause' && s.status !== 'exited';

export const paused = (s: Session) => s.interrupted?.cause === 'pause' && s.status !== 'working';

type Resumed = { resumed: number; failed: { id: string; error: string }[] };

const notResumed = ({ failed }: Resumed) => {
  for (const f of failed) toast('error', `Not resumed: ${f.error}`, { session: f.id });
};

export async function pauseAll() {
  try {
    const { stopping } = await api<{ stopping: number }>('POST', '/api/pause');
    if (!stopping) toast('info', 'No Claude is at work, so it is safe to close the laptop or restart.');
  } catch (err) {
    reportError(err);
  }
}

async function stopNow() {
  try {
    const { failed } = await api<{ failed: { id: string; error: string }[] }>('POST', '/api/pause/now');
    for (const f of failed) toast('error', `Not stopped: ${f.error}`, { session: f.id });
  } catch (err) {
    reportError(err);
  }
}

export const resumePaused = (id?: string) => api<Resumed>('POST', '/api/pause/resume', id ? { id } : {}).then(notResumed);

// After a restart that ended tasks, the paused ones show in the restart's banner instead.
function PauseBanner({ folded }: { folded: boolean }) {
  const { sessions, pause } = useStore();
  const [resuming, setResuming] = useState(false);
  const stopping = sessions.filter((s) => pause.stopping.includes(s.id));
  const finishing = stopping.filter((s) => pause.finishing.includes(s.id));
  const cleaning = stopping.filter((s) => !pause.finishing.includes(s.id));
  const longest = finishing.reduce<Session | null>((a, s) => (!a || (s.activity?.since ?? Infinity) < (a.activity?.since ?? Infinity) ? s : a), null);
  const done = sessions.filter(paused);
  if (!stopping.length && (!done.length || folded)) return null;
  const resume = async () => {
    setResuming(true);
    await resumePaused().catch(reportError);
    setResuming(false);
  };
  const dismiss = () => api('POST', '/api/pause/dismiss').catch(reportError);
  if (stopping.length) {
    return (
      <section className={styles.banner} data-pause="stopping" aria-live="polite">
        <p>
          <strong>Pausing</strong>{done.length > 0 && <> · {done.length} paused</>}
          {finishing.length > 0 && (
            <> · waiting for <TaskLinks tasks={finishing} /> to finish {finishing.length === 1 ? 'its turn' : 'their turns'}
              {longest?.activity && <> (the longest has run <Clock since={longest.activity.since} />)</>}</>
          )}
          {cleaning.length > 0 && <> · stopping the background tasks of <TaskLinks tasks={cleaning} /></>}
        </p>
        {finishing.length > 0 && <button type="button" data-stop-now onClick={() => void stopNow()} data-explain="Stop the turns still running with Esc, as Esc in the terminal would">Stop now</button>}
        <button type="button" onClick={dismiss} data-explain="Stop pausing; whatever has stopped stays stopped">Cancel</button>
      </section>
    );
  }
  return (
    <section className={styles.banner} data-pause="paused" aria-live="polite">
      <p>
        <strong>Paused {tally(done)}</strong>: <TaskLinks tasks={done} />. Safe to close the laptop or restart the Mac.
        {' '}Resume all has each one start its background tasks again and carry on.
      </p>
      <button type="button" data-variant="primary" disabled={resuming} onClick={resume}>{resuming ? 'Resuming…' : 'Resume all'}</button>
      <button type="button" onClick={dismiss} data-explain="Forget the pause; the tasks wait for you as any other">Dismiss</button>
    </section>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// "2 tasks and 3 subtasks", either left out when there are none.
function tally(list: Session[]) {
  const subtasks = list.filter((s) => s.parent).length;
  const tasks = list.length - subtasks;
  return [tasks && plural(tasks, 'task'), subtasks && plural(subtasks, 'subtask')].filter(Boolean).join(' and ');
}

const ORDER: Shown[] = ['decide', 'focus', 'idle', 'working'];

function counts(tasks: Session[]) {
  const was = tasks.map(interruptedAs);
  return ORDER.flatMap((a) => {
    const n = was.filter((w) => w === a).length;
    return n ? [`${n} ${STATE_LABELS[a].toLowerCase()}`] : [];
  }).join(', ');
}

function TaskLinks({ tasks }: { tasks: Session[] }) {
  const { repos, sessions } = useStore();
  const name = (s: Session) => sessionLabel(s, locate(repos, s).branch);
  return tasks.map((s, i) => {
    const parent = s.parent && ancestorsOf(sessions, s).at(-1);
    return (
      <span key={s.id}>
        {i > 0 && ', '}
        <button type="button" className={styles.task} onClick={() => openSheet(s.id)}>{name(s)}</button>
        {parent && <span data-subtask-of> (subtask of {name(parent)})</span>}
      </span>
    );
  });
}

const endedByRestart = (s: Session) => s.status === 'exited' && !!s.interrupted && s.interrupted.cause !== 'pause' && !s.archived;

export function RestartBanner() {
  const { sessions } = useStore();
  const ended = sessions.filter(endedByRestart);
  return (
    <>
      <PauseBanner folded={ended.length > 0} />
      <Recovery ended={ended} />
    </>
  );
}

function Recovery({ ended }: { ended: Session[] }) {
  const { sessions } = useStore();
  const [resuming, setResuming] = useState(false);
  const midTurn = sessions.filter((s) => cutShort(s) && !s.archived);
  const held = ended.length ? sessions.filter(paused) : [];
  if (!ended.length && !midTurn.length) return null;
  const both = held.length ? { paused: true } : {};

  const resume = async () => {
    setResuming(true);
    try {
      notResumed(await api<Resumed>('POST', '/api/restart/resume', both));
    } catch (err) {
      reportError(err);
    } finally {
      setResuming(false);
    }
  };
  const dismiss = () => api('POST', '/api/restart/dismiss', both).catch(reportError);

  return (
    <section className={styles.banner} data-restart="recover" data-paused={held.length || undefined} aria-live="polite">
      {held.length > 0 ? (
        <p>
          <strong>The Mac restarted</strong> and ended {tally(ended)} with it: {counts(ended)}. <strong>Paused {tally(held)}</strong>: <TaskLinks tasks={held} />.
          {' '}Resume all has each paused one start its background tasks again and carry on, and continues the others where they were.
        </p>
      ) : ended.length > 0 ? (
        <p>
          <strong>The Mac restarted</strong> and ended {tally(ended)} with it: {counts(ended)}.
          {' '}Resume all continues each one in a hidden terminal, where it was.
        </p>
      ) : (
        <p>
          <strong>{tally(midTurn)} {midTurn.length === 1 ? 'was' : 'were'} cut short mid-turn</strong> by the restart: <TaskLinks tasks={midTurn} />.
          {' '}Each waits for you; Continue the turn on its page picks it up.
        </p>
      )}
      {ended.length > 0 && <button type="button" data-variant="primary" disabled={resuming} onClick={resume}>{resuming ? 'Resuming…' : 'Resume all'}</button>}
      <button type="button" onClick={dismiss} data-explain={held.length ? 'Forget the restart and the pause; ended tasks stay on the Wall, Continue brings one back' : 'Forget what the restart cut short; ended tasks stay on the Wall, Continue brings one back'}>Dismiss</button>
    </section>
  );
}
