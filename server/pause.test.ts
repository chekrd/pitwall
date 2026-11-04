import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Interrupted, Session, SessionStatus } from './db.ts';
import { PAUSE_PROMPT, pauseMark, pauser } from './pause.ts';

type Row = Pick<Session, 'id' | 'status' | 'activity' | 'interrupted'>;

function setup() {
  let clock = 1000;
  const calls: string[] = [];
  const marked = new Map<string, Interrupted>();
  let safe = 0;
  const p = pauser({
    escape: async (id) => void calls.push(`esc ${id}`),
    type: async (id, text) => void calls.push(`type ${id} ${text === PAUSE_PROMPT ? 'pause' : text}`),
    mark: (id, i) => void marked.set(id, i),
    safe: () => void safe++,
    now: () => clock,
  });
  return { p, calls, marked, safe: () => safe, tick: (ms: number) => (clock += ms) };
}

const row = (id: string, status: SessionStatus, between = false, interrupted: Interrupted | null = null): Row => ({
  id,
  status,
  activity: status === 'working' ? { step: null, since: 0, ...(between && { between: true as const }) } : null,
  interrupted,
});

test('a Claude mid-turn finishes its turn, then gets the pause prompt, and is paused once nothing runs in the background', async () => {
  const { p, calls, marked, safe } = setup();
  assert.deepEqual(p.start([row('a', 'working'), row('b', 'idle'), row('c', 'waiting'), row('d', 'exited')]), { stopping: 1 });
  assert.deepEqual(calls, [], 'no Esc: the turn runs on');
  assert.deepEqual(p.finishing(), ['a']);
  p.step([row('a', 'working')]);
  assert.deepEqual(calls, []);
  p.step([row('a', 'working', true)]);
  assert.deepEqual(calls, ['type a pause'], 'the turn ended, its watcher still runs');
  assert.deepEqual(p.finishing(), []);
  await Promise.resolve();
  assert.equal(p.step([row('a', 'working', true)]), false, 'the prompt has not started a turn yet');
  p.step([row('a', 'working')]);
  assert.equal(p.step([row('a', 'working', true)]), false, 'the turn ended but the watcher was not stopped');
  assert.equal(safe(), 0);
  assert.equal(p.step([row('a', 'idle')]), true);
  assert.deepEqual(marked.get('a'), pauseMark(1000));
  assert.deepEqual(p.stopping(), []);
  assert.equal(safe(), 1, 'says so once the last one is paused');
});

test('a turn waiting on a permission prompt is waited on until it goes on and ends', () => {
  const { p, calls } = setup();
  p.start([row('a', 'working')]);
  p.step([row('a', 'waiting')]);
  assert.deepEqual(calls, []);
  p.step([row('a', 'idle')]);
  assert.deepEqual(calls, ['type a pause']);
});

test('Stop now sends Esc to each Claude still mid-turn, and the pause prompt follows once the turn stops', async () => {
  const { p, calls } = setup();
  p.start([row('a', 'working'), row('b', 'working', true)]);
  assert.deepEqual(calls, ['type b pause']);
  assert.deepEqual(await p.hurry([row('a', 'working'), row('b', 'working', true)]), { failed: [] });
  assert.deepEqual(calls, ['type b pause', 'esc a']);
  assert.deepEqual(p.finishing(), []);
  p.step([row('a', 'working'), row('b', 'working')]);
  assert.deepEqual(calls, ['type b pause', 'esc a'], 'Esc has not landed yet');
  p.step([row('a', 'idle'), row('b', 'working')]);
  assert.deepEqual(calls, ['type b pause', 'esc a', 'type a pause']);
});

test('a Claude between turns with only background work running is asked at once', () => {
  const { p, calls } = setup();
  p.start([row('a', 'working', true)]);
  assert.deepEqual(calls, ['type a pause']);
  assert.deepEqual(p.stopping(), ['a']);
});

test('a turn that starts while pausing is waited on too, but not one of a task already paused', () => {
  const { p } = setup();
  p.start([row('a', 'working')]);
  p.step([row('a', 'working'), row('b', 'working'), row('c', 'working', false, pauseMark(1))]);
  assert.deepEqual(p.stopping(), ['a', 'b']);
});

test('an idle Claude whose pause prompt never started a turn counts as paused after a minute', () => {
  const { p, marked, tick } = setup();
  p.start([row('a', 'working')]);
  p.step([row('a', 'idle')]);
  assert.equal(p.step([row('a', 'idle')]), false);
  tick(61_000);
  assert.equal(p.step([row('a', 'idle')]), true);
  assert.ok(marked.has('a'));
});

test('a Claude that ends while pausing is paused, so Resume brings it back; one that Esc could not reach waits on', async () => {
  const marked = new Map<string, Interrupted>();
  const p = pauser({
    escape: async (id) => {
      if (id === 'b') throw new Error('no terminal');
    },
    type: async () => {},
    mark: (id, i) => void marked.set(id, i),
  });
  p.start([row('a', 'working'), row('b', 'working')]);
  const { failed } = await p.hurry([row('a', 'working'), row('b', 'working')]);
  assert.deepEqual(failed, [{ id: 'b', error: 'no terminal' }]);
  assert.deepEqual(p.finishing(), ['b']);
  p.step([row('a', 'exited'), row('b', 'working')]);
  assert.ok(marked.has('a'));
  assert.deepEqual(p.stopping(), ['b']);
});

test('Cancel calls off a pause prompt still waiting for its turn to be typed, and a new pause asks again', () => {
  const asked: (() => boolean)[] = [];
  const p = pauser({ escape: async () => {}, type: async (_id, _text, wanted) => void asked.push(wanted), mark: () => {} });
  p.start([row('a', 'working', true)]);
  assert.equal(asked[0](), true);
  p.cancel();
  assert.equal(asked[0](), false);
  p.start([row('a', 'working', true)]);
  assert.deepEqual(asked.map((wanted) => wanted()), [false, true]);
});

test('Cancel stops following the tasks, and says nothing', () => {
  const { p, safe } = setup();
  p.start([row('a', 'working')]);
  p.cancel();
  assert.deepEqual(p.stopping(), []);
  assert.equal(p.step([row('a', 'idle')]), false);
  assert.equal(safe(), 0);
});
