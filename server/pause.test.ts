import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Interrupted, Session, SessionStatus } from './db.ts';
import { PAUSE_PROMPT, pauseMark, pauser } from './pause.ts';

type Row = Pick<Session, 'id' | 'status' | 'activity'>;

function setup() {
  let clock = 1000;
  const calls: string[] = [];
  const marked = new Map<string, Interrupted>();
  const p = pauser({
    escape: async (id) => void calls.push(`esc ${id}`),
    type: async (id, text) => void calls.push(`type ${id} ${text === PAUSE_PROMPT ? 'pause' : text}`),
    mark: (id, i) => void marked.set(id, i),
    now: () => clock,
  });
  return { p, calls, marked, tick: (ms: number) => (clock += ms) };
}

const row = (id: string, status: SessionStatus, between = false): Row => ({ id, status, activity: status === 'working' ? { step: null, since: 0, ...(between && { between: true as const }) } : null });

test('a Claude mid-turn gets Esc, then the pause prompt once the turn stops, and is paused once that turn ends with nothing in the background', async () => {
  const { p, calls, marked } = setup();
  assert.deepEqual(await p.start([row('a', 'working'), row('b', 'idle'), row('c', 'waiting'), row('d', 'exited')]), { stopping: 1, failed: [] });
  assert.deepEqual(calls, ['esc a']);
  p.step([row('a', 'working')]);
  assert.deepEqual(calls, ['esc a'], 'Esc has not landed yet');
  p.step([row('a', 'working', true)]);
  assert.deepEqual(calls, ['esc a', 'type a pause'], 'the turn stopped, its watcher still runs');
  await Promise.resolve();
  assert.equal(p.step([row('a', 'working', true)]), false, 'the prompt has not started a turn yet');
  p.step([row('a', 'working')]);
  assert.equal(p.step([row('a', 'working', true)]), false, 'the turn ended but the watcher was not stopped');
  assert.equal(p.step([row('a', 'idle')]), true);
  assert.deepEqual(marked.get('a'), pauseMark(1000));
  assert.deepEqual(p.stopping(), []);
});

test('a Claude between turns with only background work running is asked at once, without Esc', async () => {
  const { p, calls } = setup();
  await p.start([row('a', 'working', true)]);
  assert.deepEqual(calls, ['type a pause']);
  assert.deepEqual(p.stopping(), ['a']);
});

test('an idle Claude whose pause prompt never started a turn counts as paused after a minute', async () => {
  const { p, marked, tick } = setup();
  await p.start([row('a', 'working')]);
  p.step([row('a', 'idle')]);
  assert.equal(p.step([row('a', 'idle')]), false);
  tick(61_000);
  assert.equal(p.step([row('a', 'idle')]), true);
  assert.ok(marked.has('a'));
});

test('a Claude that ends while pausing is paused, so Resume brings it back; one that Esc could not reach is left out', async () => {
  const marked = new Map<string, Interrupted>();
  const p = pauser({
    escape: async (id) => {
      if (id === 'b') throw new Error('no terminal');
    },
    type: async () => {},
    mark: (id, i) => void marked.set(id, i),
  });
  const { failed } = await p.start([row('a', 'working'), row('b', 'working')]);
  assert.deepEqual(failed, [{ id: 'b', error: 'no terminal' }]);
  p.step([row('a', 'exited')]);
  assert.ok(marked.has('a'));
  assert.deepEqual(p.stopping(), []);
});

test('Cancel stops following the tasks', async () => {
  const { p } = setup();
  await p.start([row('a', 'working')]);
  p.cancel();
  assert.deepEqual(p.stopping(), []);
});
