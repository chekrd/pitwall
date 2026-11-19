import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from './db.ts';
import { answeredLine, answerText, checkDecision, claim, decisionKey, menuAnswerText, openDecision } from './decision.ts';
import type { Round } from './rounds.ts';

const session = (patch: Partial<Session>): Session => ({
  id: 's', conversation: 's', history: [], repoId: 1, worktree: '/w', cwd: '/w', pid: 1, tty: null, title: null, firstPrompt: null, status: 'idle',
  question: null, diffstat: null, lastMessage: null, lastPrompt: null, unanswered: null, lastTurn: 't2', waitingFor: null,
  dismissedAsk: null, round: null, dismissedRound: null, prs: [], activity: null, menu: null, answered: null, artifacts: [], links: [], model: null, effort: null, context: null, interrupted: null, turnError: null, scheduled: null, starting: null, parked: [], asides: [], aliveAt: null,
  archived: false, createdAt: 0, updatedAt: 0, ...patch,
});

const question = { toolUseId: 'q1', title: 'Which way?', details: 'd', options: [], category: 'plan-problem', askedAt: 1 };
const menu = { toolUseId: 'm1', at: 2, questions: [{ question: 'Colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }] }] };

const round: Round = {
  key: 'r1', source: 'tool', title: 'Round 1', intro: '', at: 3,
  questions: [
    { id: 'Q1', title: 'Audience', body: 'Who is it for?', options: [{ label: 'Only me' }, { label: 'Friends' }], recommendation: 'Only you.', recommended: 'Only me' },
    { id: 'Q2', title: 'Sources', body: 'Which sources?', options: [], recommendation: '', recommended: null },
  ],
};

const answered = (key: string | null, text = 'Ship', at = 100) => ({ key, text, at });

// Like the database: every update makes a new row.
const store = (s: Session) => {
  let row = s;
  return { get: () => row, update: (_: string, patch: Partial<Session>) => void (row = { ...row, ...patch }) };
};

test('a menu comes before an ask_human call', () => {
  assert.equal(openDecision(session({ question, menu }))?.key, 'm:m1');
  assert.equal(openDecision(session({ question }))?.key, 'q:q1');
  assert.match(openDecision(session({ menu }))!.details, /1\. \[Colour\] Colour\? \(pick one, or write an own answer\)\n {3}- Red/);
});

test('an ended or archived session waits on nothing, nor one with no question, menu or round open', () => {
  assert.equal(openDecision(session({ question, status: 'exited' })), null);
  assert.equal(openDecision(session({ question, archived: true })), null);
  assert.equal(openDecision(session({ lastMessage: 'Should I ship it?' })), null);
});

test('the decision the page shows, archived and ended sessions included', () => {
  assert.equal(decisionKey(session({ question, archived: true })), 'q:q1');
  assert.equal(decisionKey(session({ question, status: 'exited' })), 'q:q1');
  assert.equal(decisionKey(session({ question, menu })), 'm:m1');
  assert.equal(decisionKey(session({ lastMessage: 'Should I ship it?' })), null);
});

test('acting on the decision the page showed goes through while it is still open', () => {
  for (const s of [session({ menu }), session({ question }), session({})]) assert.doesNotThrow(() => checkDecision(s, decisionKey(s)));
});

test('a decision that was replaced, answered in the terminal or moved on from is no longer open', () => {
  const stale = { message: /no longer open/, code: 'stale' };
  assert.throws(() => checkDecision(session({ question }), 'q:q0'), stale);
  assert.throws(() => checkDecision(session({ status: 'working' }), 'q:q1'), stale);
  assert.throws(() => checkDecision(session({ question, menu }), 'q:q1'), stale);
});

test('with no decision on the page, a send meets none that Claude asked meanwhile', () => {
  const asked = { message: /asked something meanwhile/, code: 'stale' };
  assert.throws(() => checkDecision(session({ question }), null), asked);
  assert.throws(() => checkDecision(session({ menu }), null), asked);
  assert.throws(() => checkDecision(session({ round }), null), asked);
});

test('a page from before decision keys is told to reload', () => {
  assert.throws(() => checkDecision(session({}), undefined), { message: /out of date/, code: 'out-of-date' });
});

test('an answered decision is closed at once, before the terminal or the transcript catch up', () => {
  for (const [s, key] of [[session({ menu }), 'm:m1'], [session({ question }), 'q:q1'], [session({ round }), 'r:r1']] as const) {
    assert.equal(decisionKey(s), key);
    const done = { ...s, answered: answered(key) };
    assert.equal(decisionKey(done), null);
    assert.equal(openDecision(done), null);
    assert.throws(() => checkDecision(done, key), { message: /already answered/, code: 'answered' });
  }
});

test('an answer closes only its own decision', () => {
  assert.equal(decisionKey(session({ question: { ...question, toolUseId: 'q2' }, answered: answered('q:q1') })), 'q:q2');
  assert.equal(decisionKey(session({ question, answered: answered(null) })), 'q:q1');
});

test('a message typed after an answered decision goes through as a plain message', () => {
  assert.doesNotThrow(() => checkDecision(session({ question, answered: answered('q:q1') }), null));
});

test('a claim checks and closes in one step, and reopen() gives the decision back', () => {
  const st = store(session({ question }));
  const { reopen } = claim(st, 's', 'q:q1', 'Ship');
  assert.equal(decisionKey(st.get()), null);
  assert.equal(st.get().answered?.text, 'Ship');
  assert.throws(() => claim(st, 's', 'q:q1', 'Ship'), { code: 'answered' });
  reopen();
  assert.equal(decisionKey(st.get()), 'q:q1');
  assert.throws(() => claim(st, 's', 'q:q0', 'Ship'), { code: 'stale' });
  assert.throws(() => claim({ get: () => undefined, update: () => {} }, 'gone', null, 'Hi'), /unknown session gone/);
});

test('a claim keeps the first 500 characters of what it sent', () => {
  const st = store(session({ question }));
  claim(st, 's', 'q:q1', 'x'.repeat(600));
  assert.equal(st.get().answered?.key, 'q:q1');
  assert.equal(st.get().answered?.text.length, 500);
});

test('a plain message after an answer keeps that decision closed', () => {
  const st = store(session({ question }));
  claim(st, 's', 'q:q1', 'Ship');
  claim(st, 's', null, 'And add a changelog entry');
  assert.equal(decisionKey(st.get()), null);
  assert.deepEqual([st.get().answered?.key, st.get().answered?.text], ['q:q1', 'And add a changelog entry']);
  assert.throws(() => claim(st, 's', 'q:q1', 'Ship'), { code: 'answered' });
});

test('a stale reopen() leaves a later claim in place', (t) => {
  const st = store(session({}));
  const one = claim(st, 's', null, 'one');
  claim(st, 's', null, 'two');
  one.reopen();
  assert.equal(st.get().answered?.text, 'two');

  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const again = store(session({}));
  const first = claim(again, 's', null, 'again');
  claim(again, 's', null, 'again');
  const later = again.get().answered;
  first.reopen();
  assert.equal(again.get().answered, later, 'the same text in the same millisecond');
});

test('reopen() restores the record from before the claim, also in a store that updates rows in place', () => {
  const row = session({ question, answered: answered(null, 'earlier', 50) });
  const st = { get: () => row, update: (_: string, patch: Partial<Session>) => void Object.assign(row, patch) };
  const { reopen } = claim(st, 's', 'q:q1', 'A');
  assert.equal(decisionKey(row), null);
  reopen();
  assert.deepEqual(row.answered, answered(null, 'earlier', 50));
  assert.equal(decisionKey(row), 'q:q1');
});

test('the answer text names the choice once, then the note and the files', () => {
  assert.equal(answerText('Ship', '', 0), 'Ship');
  assert.equal(answerText('Ship', 'after lunch', 0), 'Ship — after lunch');
  assert.equal(answerText(undefined, 'Use the cache', 2), 'Use the cache (+2 files)');
  assert.equal(answerText(undefined, '', 1), '(+1 file)');
});

test('a menu answer reads one part per question, an own answer instead of the options', () => {
  const two = {
    toolUseId: 'm2', at: 2, questions: [
      { question: 'Colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] },
      { question: 'Which sizes?', header: '', multiSelect: true, options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }] },
    ],
  };
  assert.equal(menuAnswerText(two, [{ labels: [], other: ' Teal ' }, { labels: ['S', 'L'], other: '' }]), 'Colour: Teal · Which sizes?: S, L');
});

test('"You answered" shows until Claude starts a turn the answer did not start', () => {
  const a = answered('q:q1', 'Ship', 100_000);
  assert.equal(answeredLine(session({ answered: a, activity: { step: null, since: 101_000 } })), 'Ship');
  assert.equal(answeredLine(session({ answered: a, activity: { step: 'Edit a.ts', since: 40_000 } })), 'Ship');
  assert.equal(answeredLine(session({ answered: a })), 'Ship');
  assert.equal(answeredLine(session({ answered: a, activity: { step: 'Edit a.ts', since: 200_000 } })), null);
  assert.equal(answeredLine(session({ activity: { step: null, since: 101_000 } })), null);
});

test('a round of questions is a decision that comes after a menu and an ask_human call', () => {
  const d = openDecision(session({ round }));
  assert.deepEqual([d?.key, d?.title, d?.category, d?.askedAt, d?.round], ['r:r1', 'Round 1', 'round of questions', 3, round]);
  assert.equal(d?.details, 'Q1 — Audience: Who is it for?\n   - Only me\n   - Friends\n   Claude recommends: Only you.\nQ2 — Sources: Which sources?');
  assert.equal(decisionKey(session({ round, question })), 'q:q1');
  assert.equal(decisionKey(session({ round, menu, status: 'waiting' })), 'm:m1');
  assert.equal(decisionKey(session({ round, status: 'working' })), 'r:r1', 'it waits while Claude writes on after it');
  assert.equal(decisionKey(session({ round, answered: answered('r:r1') })), null);
});
