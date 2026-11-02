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

// The board writes a task's row only while it runs, and its first sync after a boot finds the dead Claudes before
// anything else touches their rows: one it last wrote before the boot was alive until the restart killed it.
export function interruption(s: Pick<Session, 'status' | 'updatedAt' | 'waitingFor' | 'menu'>, boot: number | null): Interrupted | null {
  if (s.status === 'exited' || boot === null || s.updatedAt >= boot) return null;
  return { at: boot, status: s.status, waitingFor: s.waitingFor, menu: s.menu };
}

// Resumed, a task that was only waiting for you is as it was; one cut short mid-turn, or at a prompt the restart took
// away, stays marked until Claude works again.
export const pickedUp = (i: Interrupted, status: Session['status']) => status === 'working' || i.status === 'idle';
