import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interruption, parseBootTime, pickedUp } from './restart.ts';

test('the boot time is read from sysctl kern.boottime, in milliseconds', () => {
  assert.equal(parseBootTime('{ sec = 1793086205, usec = 497711 } Tue Oct 27 08:30:05 2026\n'), 1_793_086_205_000);
  assert.equal(parseBootTime(''), null);
});

test('a task last seen alive before the boot was cut short by the restart, with what it was doing', () => {
  const menu = { toolUseId: 'm1', questions: [], at: 50 };
  const before = { status: 'waiting' as const, aliveAt: null, updatedAt: 100, waitingFor: 'permission to run Bash', menu };
  assert.deepEqual(interruption(before, 200), { at: 200, status: 'waiting', waitingFor: 'permission to run Bash', menu });
  assert.equal(interruption({ ...before, updatedAt: 300 }, 200), null, 'it ran after the boot, so it ended on its own');
  assert.equal(interruption({ ...before, status: 'exited' }, 200), null, 'it had ended before the restart');
  assert.equal(interruption(before, null), null, 'no boot time, no guess');
});

test('when its Claude was last seen alive decides, whatever wrote to the row after the boot', () => {
  const row = { status: 'working' as const, waitingFor: null, menu: null };
  assert.equal(interruption({ ...row, aliveAt: 100, updatedAt: 300 }, 200)?.at, 200, 'a summary written after the boot');
  assert.equal(interruption({ ...row, aliveAt: 250, updatedAt: 300 }, 200), null, 'seen alive after the boot, so it ended on its own');
});

test('a resumed task is picked up at once when it only waited for you, and once Claude works again otherwise', () => {
  const at = (status: 'working' | 'idle' | 'waiting') => ({ at: 1, status, waitingFor: null, menu: null });
  assert.equal(pickedUp(at('idle'), 'idle'), true);
  assert.equal(pickedUp(at('working'), 'idle'), false);
  assert.equal(pickedUp(at('waiting'), 'idle'), false);
  assert.equal(pickedUp(at('working'), 'working'), true);
});
