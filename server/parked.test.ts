import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftMessage } from './codeRef.ts';
import type { Parked, Session } from './db.ts';
import { addParked, editParked, removeParked, SUMMARY_WAIT_MS, turnEnds } from './parked.ts';

const session = (patch: Partial<Session>): Session => ({
  id: 's', conversation: 's', history: [], repoId: 1, worktree: '/w', cwd: '/w', pid: 1, tty: '/dev/ttys1', title: null, firstPrompt: null, status: 'working',
  question: null, rank: null, rankReason: null, priority: null, diffstat: null, lastMessage: null, lastPrompt: null, unanswered: null, lastTurn: 't2', waitingFor: null,
  dismissedAsk: null, round: null, dismissedRound: null, advice: null, prs: [], summary: null, explanation: null, activity: null, menu: null, answered: null, artifacts: [], links: [], findings: null, parent: null, resolution: null, model: null, effort: null, interrupted: null, turnError: null, scheduled: null, starting: null, parked: [], asides: [], aliveAt: null,
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

test('drafts armed during a turn go out one per turn: the first when it ends, the next when the turn it started ends', () => {
  const { w, idle } = ended();
  assert.deepEqual(w.observe([idle], [], 200), [{ id: 's', ids: ['a'], text: 'First' }]);
  const left = [draft('b', 160, 'Second')];
  assert.deepEqual(w.observe([{ ...idle, parked: left }], [], 300), [], 'the end was used up');
  const answered = { key: null, text: 'First', at: 200 };
  assert.deepEqual(w.observe([session({ parked: left, answered })], [], 400), []);
  assert.deepEqual(w.observe([session({ status: 'idle', parked: left, answered, lastTurn: 't3', summary: summary('t3') })], [], 500), [{ id: 's', ids: ['b'], text: 'Second' }]);
});

test('only drafts armed to send are sent, not the ones kept for a press', () => {
  const { w, idle } = ended({}, [draft('k', null), draft('a', 150), draft('b', 160)]);
  assert.deepEqual(w.observe([idle], [], 200)[0].ids, ['a']);
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

test('a draft written about lines of the diff reaches Claude with their path, numbers and code, then the draft', () => {
  const ref = { path: 'web/src/cart.ts', side: 'new' as const, start: 12, end: 13, lines: ['const total = sum(items);', 'return total;'] };
  assert.equal(draftMessage({ text: 'Round it.', ref }), 'About `web/src/cart.ts` lines 12–13:\n```\nconst total = sum(items);\nreturn total;\n```\n\nRound it.');
  assert.equal(draftMessage({ text: 'Why?', ref: { ...ref, side: 'old', end: 12, lines: ['x = ```y```'] } }),
    'About `web/src/cart.ts` line 12 as the base branch has them (the diff removes or changes them):\n````\nx = ```y```\n````\n\nWhy?');
  assert.match(draftMessage({ text: 'Split it.', ref: { ...ref, end: 100 } }), /``` \(the first 2 of 89 lines\)\n\nSplit it\.$/);
  assert.equal(draftMessage({ text: 'Plain.' }), 'Plain.');
});

test('a kept draft keeps the lines it was written about, and the turn end sends them with it', () => {
  const ref = { path: 'a.ts', side: 'new' as const, start: 3, end: 3, lines: ['let a = 1;'] };
  const [kept] = addParked([], { text: 'Make it const.', auto: true, ref }, 50);
  assert.deepEqual(kept.ref, ref);
  assert.deepEqual(editParked([kept], { draft: kept.id, text: 'Inline it.' })[0].ref, ref, 'editing the text keeps the lines');
  assert.equal(addParked([], { text: 'No lines.' })[0].ref, undefined);
  const { w, idle } = ended({}, [kept]);
  assert.equal(w.observe([idle], [], 200)[0]?.text, 'About `a.ts` line 3:\n```\nlet a = 1;\n```\n\nMake it const.');
});
