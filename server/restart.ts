import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Interrupted, Session } from './db.ts';

const run = promisify(execFile);

// `{ sec = 1793086205, usec = 497711 } Tue Oct 27 08:30:05 2026`
export function parseBootTime(out: string) {
  const sec = out.match(/\bsec = (\d+)/)?.[1];
  return sec ? Number(sec) * 1000 : null;
}

let boot: Promise<number | null> | undefined;

export const bootTime = () =>
  (boot ??= run('/usr/sbin/sysctl', ['-n', 'kern.boottime']).then(({ stdout }) => parseBootTime(stdout), () => null));

// No process outlives a boot, so a task whose Claude the sync last saw alive before the boot, and which it had not seen
// end, was alive until the restart killed it. A row from before aliveAt was recorded goes by its last write, which
// is as good only while nothing but the sync writes to the rows of ended Claudes.
export function interruption(s: Pick<Session, 'status' | 'aliveAt' | 'updatedAt' | 'waitingFor' | 'menu'>, boot: number | null): Interrupted | null {
  if (s.status === 'exited' || boot === null || (s.aliveAt ?? s.updatedAt) >= boot) return null;
  return { at: boot, status: s.status, waitingFor: s.waitingFor, menu: s.menu };
}

// Resumed, a task that was only waiting for you is as it was; one cut short mid-turn, or at a prompt the restart took
// away, stays marked until Claude works again.
export const pickedUp = (i: Interrupted, status: Session['status']) => status === 'working' || i.status === 'idle';

// Archived, a task is done with, and the restart's claim on it goes: brought back later, it is ended as any other.
// A pause's mark stays, since the pause still has the task to carry on.
export const archivePatch = (s: Pick<Session, 'interrupted' | 'resolution'>, archived: boolean): Pick<Session, 'archived'> & Partial<Pick<Session, 'interrupted' | 'resolution'>> => ({
  archived,
  ...(archived && s.interrupted && s.interrupted.cause !== 'pause' && { interrupted: null }),
  ...(!archived && s.resolution && { resolution: null }),
});
