import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanup } from './cleanup.ts';

function fakeTimers() {
  const ticks: { fn: () => void; ms: number; unrefed: boolean; cleared: boolean }[] = [];
  return {
    ticks,
    timers: {
      setInterval: (fn: () => void, ms: number) => {
        const t = { fn, ms, unrefed: false, cleared: false };
        ticks.push(t);
        return { unref: () => void (t.unrefed = true), t };
      },
      clearInterval: (handle: { t: { cleared: boolean } }) => void (handle.t.cleared = true),
    },
    tick: () => {
      for (const t of ticks) if (!t.cleared) t.fn();
    },
  };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

test('the jobs run once at start and then on every tick of an hourly timer that does not keep the process alive', async () => {
  const f = fakeTimers();
  const ran: string[] = [];
  const stop = cleanup([{ name: 'a', run: () => void ran.push('a') }, { name: 'b', run: async () => void ran.push('b') }], { timers: f.timers }).start();
  await settled();
  assert.deepEqual(ran, ['a', 'b']);
  assert.equal(f.ticks.length, 1);
  assert.equal(f.ticks[0].ms, 3600_000);
  assert.equal(f.ticks[0].unrefed, true);
  f.tick();
  await settled();
  assert.deepEqual(ran, ['a', 'b', 'a', 'b']);
  stop();
  f.tick();
  await settled();
  assert.equal(ran.length, 4, 'stopped, it runs no more');
});

test('a job that throws is logged and the others still run, then and on the next pass', async () => {
  const f = fakeTimers();
  const warned: string[] = [];
  const ran: string[] = [];
  const c = cleanup([
    { name: 'broken', run: () => { throw new Error('disk gone'); } },
    { name: 'rejects', run: () => Promise.reject(new Error('no access')) },
    { name: 'fine', run: () => void ran.push('fine') },
  ], { timers: f.timers, warn: (message, err) => void warned.push(`${message}: ${(err as Error).message}`) });
  await c.runAll();
  await c.runAll();
  assert.deepEqual(ran, ['fine', 'fine']);
  assert.deepEqual(warned, ['clean-up broken failed: disk gone', 'clean-up rejects failed: no access', 'clean-up broken failed: disk gone', 'clean-up rejects failed: no access']);
});

test('a pass still running when the next is due is not started twice', async () => {
  const f = fakeTimers();
  let started = 0;
  let finish!: () => void;
  const c = cleanup([{ name: 'slow', run: () => new Promise<void>((done) => { started++; finish = done; }) }], { timers: f.timers });
  c.start();
  await settled();
  f.tick();
  f.tick();
  await settled();
  assert.equal(started, 1);
  finish();
  await settled();
  f.tick();
  await settled();
  assert.equal(started, 2);
});
