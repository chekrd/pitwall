import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Parked, Session } from './db.ts';
import { addParked, editParked, removeParked, SUMMARY_WAIT_MS, turnEnds } from './parked.ts';

const session = (patch: Partial<Session>): Session => ({
  id: 's', conversation: 's', history: [], repoId: 1, worktree: '/w', cwd: '/w', pid: 1, tty: '/dev/ttys1', title: null, firstPrompt: null, status: 'working',
  question: null, rank: null, rankReason: null, priority: null, diffstat: null, lastMessage: null, lastPrompt: null, lastTurn: 't2', waitingFor: null,
  dismissedAsk: null, advice: null, prs: [], summary: null, explanation: null, activity: null, menu: null, answered: null, artifacts: [], links: [], findings: null, parent: null, resolution: null, model: null, effort: null, interrupted: null, turnError: null, scheduled: null, parked: [], asides: [],
  archived: false, createdAt: 0, updatedAt: 0, ...patch,
});

const draft = (id: string, armedAt: number | null, text = id): Parked => ({ id, text, auto: armedAt !== null, armedAt, at: 0 });

const summary = (basis: string, decision = false) => ({
  text: 'h', basis, at: 5, question: null,
  decision: decision ? { problem: 'Ship it?', brief: 'b', options: [{ label: 'Ship' }] } : null,
});

// A turn that ran from 100 and ended at 200 with its summary written, the drafts armed at 150.
function ended(patch: Partial<Session> = {}, parked = [draft('a', 150, 'First'), draft('b', 160, 'Second')]) {
  const w = turnEnds();
  assert.deepEqual(w.observe([session({ parked })], [], 100), []);
  return { w, idle: session({ status: 'idle', parked, summary: summary('t2'), ...patch }) };
}

test('drafts armed during a turn go out as one message when it ends, once', () => {
  const { w, idle } = ended();
  assert.deepEqual(w.observe([idle], [], 200), [{ id: 's', ids: ['a', 'b'], text: 'First\n\nSecond' }]);
  assert.deepEqual(w.observe([idle], [], 300), []);
});

test('only drafts armed to send are sent, not the ones kept for a press', () => {
  const { w, idle } = ended({}, [draft('a', 150), draft('k', null), draft('b', 160)]);
  assert.deepEqual(w.observe([idle], [], 200)[0].ids, ['a', 'b']);
});

test('a draft armed after the turn ended waits for the next end', () => {
  const { w, idle } = ended({}, []);
  assert.deepEqual(w.observe([idle], [], 200), []);
  assert.deepEqual(w.observe([{ ...idle, parked: [draft('late', 250)] }], [], 260), []);
});

test('no end of turn without having seen Claude work: a board that starts on an idle task sends nothing', () => {
  const w = turnEnds();
  assert.deepEqual(w.observe([session({ status: 'idle', parked: [draft('a', 1)], summary: summary('t2') })], [], 200), []);
});

test('a permission prompt or a menu is not the end of a turn', () => {
  const w = turnEnds();
  const parked = [draft('a', 50)];
  w.observe([session({ parked })], [], 100);
  assert.deepEqual(w.observe([session({ status: 'waiting', parked })], [], 150), []);
  assert.deepEqual(w.observe([session({ status: 'idle', parked, summary: summary('t2') })], [], 160), []);
});

test('nothing goes out when you replied after the turn ended', () => {
  const { w, idle } = ended({ answered: { key: null, text: 'mine', at: 200 } });
  assert.deepEqual(w.observe([idle], [], 200), []);
  assert.deepEqual(w.observe([{ ...idle, answered: null }], [], 210), [], 'the end was used up');
});

test('a reply from before the end does not hold it back', () => {
  const { w, idle } = ended({ answered: { key: null, text: 'the prompt of this turn', at: 90 } });
  assert.equal(w.observe([idle], [], 200).length, 1);
});

test('nothing goes out for a paused, pausing, archived, interrupted or failed task', () => {
  for (const [patch, pausing] of [
    [{ archived: true }, []],
    [{}, ['s']],
    [{ interrupted: { at: 1, cause: 'pause', status: 'working', waitingFor: null, menu: null } }, []],
    [{ turnError: { kind: 'limit', text: 'x' } }, []],
  ] as [Partial<Session>, string[]][]) {
    const { w, idle } = ended(patch);
    assert.deepEqual(w.observe([idle], pausing, 200), [], JSON.stringify(patch));
  }
});

test('a turn that ended on a question keeps its drafts', () => {
  const { w, idle } = ended({ summary: summary('t2', true) });
  assert.deepEqual(w.observe([idle], [], 200), []);
  const asked = ended({ question: { toolUseId: 'q', title: 'Which?', details: '', options: [], category: 'c', askedAt: 1 } });
  assert.deepEqual(asked.w.observe([asked.idle], [], 200), []);
});

test("it waits for the turn's summary, and past the wait sends without it", () => {
  const { w, idle } = ended({ summary: summary('t1') });
  assert.deepEqual(w.observe([idle], [], 200), []);
  assert.deepEqual(w.observe([idle], [], 200 + SUMMARY_WAIT_MS - 1), []);
  assert.equal(w.observe([idle], [], 200 + SUMMARY_WAIT_MS).length, 1);
});

test('Claude working again before the summary came cancels the end', () => {
  const { w, idle } = ended({ summary: summary('t1') });
  w.observe([idle], [], 200);
  w.observe([{ ...idle, status: 'working' }], [], 210);
  assert.deepEqual(w.observe([{ ...idle, summary: summary('t2') }], [], 220).length, 1, 'that is a new end');
  assert.deepEqual(w.observe([{ ...idle, summary: summary('t2') }], [], 230), []);
});

test('drafts are added, edited, armed from the moment they are switched on, and removed', () => {
  let list = addParked([], { text: '  Check the  docs ' }, 10);
  assert.equal(list[0].text, 'Check the  docs');
  assert.equal(list[0].armedAt, null);
  const id = list[0].id;
  list = editParked(list, { draft: id, auto: true }, 20);
  assert.equal(list[0].armedAt, 20);
  list = editParked(list, { draft: id, text: 'Check the docs' }, 30);
  assert.deepEqual([list[0].text, list[0].armedAt], ['Check the docs', 20], 'editing the text keeps it armed as it was');
  list = editParked(list, { draft: id, auto: false }, 40);
  assert.equal(list[0].armedAt, null);
  assert.throws(() => addParked([], { text: '   ' }), /empty/);
  assert.throws(() => editParked(list, { draft: 'gone', text: 'x' }), /gone/);
  assert.deepEqual(removeParked(list, [id]), []);
});
