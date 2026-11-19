import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextDecision, orderTiles, waitingLabel, waitingOf, waitingSince } from './order.ts';
import { menu, options, question, session } from './testing.ts';
import type { Round, Session } from './types.ts';

const round = (key: string, at: number): Round => ({ key, source: 'tool', title: 'Round', intro: '', at, questions: [] });

const ids = (list: Session[]) => list.map((s) => s.id);

test('decisions come first, then Needs focus, Your turn, working and ended', () => {
  const { active } = orderTiles([
    session('ended', { status: 'exited' }),
    session('working', { status: 'working' }),
    session('your-turn'),
    session('needs-focus', { status: 'waiting', waitingFor: 'a permission prompt' }),
    session('ask', { question: question('q3') }),
    session('menu', { status: 'waiting', menu: menu('m1') }),
  ]);
  assert.deepEqual(ids(active), ['ask', 'menu', 'needs-focus', 'your-turn', 'working', 'ended']);
});

test('within a kind the one waiting longest comes first: a decision by when it was asked, any other by when it last changed', () => {
  const { active } = orderTiles([
    session('new-turn', { updatedAt: 300 }),
    session('old-turn', { updatedAt: 100, createdAt: 9 }),
    session('new-prompt', { status: 'waiting', updatedAt: 250 }),
    session('old-prompt', { status: 'waiting', updatedAt: 50 }),
    session('late-ask', { question: question('q2', undefined, 40), updatedAt: 1 }),
    session('round', { round: round('r1', 20), updatedAt: 500 }),
    session('early-menu', { status: 'waiting', menu: { ...menu('m1'), at: 10 }, updatedAt: 900 }),
  ]);
  assert.deepEqual(ids(active), ['early-menu', 'round', 'late-ask', 'old-prompt', 'new-prompt', 'old-turn', 'new-turn']);
  assert.equal(waitingSince(active[2]), 40);
  assert.equal(waitingSince(active[3]), 50);
});

test('a question Claude asks in plain text is a finished turn, not a decision', () => {
  const { active } = orderTiles([
    session('plain', { lastMessage: 'Should I ship it?', updatedAt: 1 }),
    session('needs-focus', { status: 'waiting', updatedAt: 5 }),
    session('decision', { question: question('q1'), createdAt: 5 }),
  ]);
  assert.deepEqual(ids(active), ['decision', 'needs-focus', 'plain']);
});

test('tasks at work and ended ones keep the order they started in', () => {
  const { active } = orderTiles([
    session('newer', { status: 'working', createdAt: 2, updatedAt: 1 }),
    session('older', { status: 'working', createdAt: 1, updatedAt: 9 }),
  ]);
  assert.deepEqual(ids(active), ['older', 'newer']);
});

test('archived tasks are listed apart, the most recently changed first', () => {
  const { active, archived } = orderTiles([
    session('old', { archived: true, updatedAt: 1, question: question('q1') }),
    session('live'),
    session('recent', { archived: true, updatedAt: 2, status: 'exited' }),
  ]);
  assert.deepEqual(ids(active), ['live']);
  assert.deepEqual(ids(archived), ['recent', 'old']);
});

const none = new Set<string>();
const ask = (id: string, patch: Partial<Session> = {}) => session(id, { question: question(`q-${id}`), ...patch });

test('what waits on you: decisions, the longest waiting first; then Needs focus, then Your turn', () => {
  const waiting = waitingOf([
    session('your-turn', { createdAt: 1 }),
    session('needs-focus', { status: 'waiting', waitingFor: 'permission prompt' }),
    session('late', { question: question('q-late', options('A'), 30) }),
    session('early', { question: question('q-early', options('A'), 10) }),
    session('menu', { status: 'waiting', menu: { ...menu('m1'), at: 20 } }),
  ], none);
  assert.deepEqual(ids(waiting), ['early', 'menu', 'late', 'needs-focus', 'your-turn']);
  assert.equal(waitingLabel(waiting), '3 decisions · 1 terminal prompt · 1 finished turn');
  assert.equal(waitingLabel([]), '');
});

test('what waits leaves out archived, working, ended and busy tasks, an ended one with an open question, and an answered menu still open', () => {
  const waiting = waitingOf([
    ask('archived', { archived: true }),
    session('working', { status: 'working' }),
    session('ended', { status: 'exited' }),
    ask('gone', { status: 'exited' }),
    ask('held'),
    session('hooks', { status: 'waiting', menu: menu('m1'), answered: { key: 'm:m1', text: 'Backoff: Linear', at: 100_000 } }),
    ask('kept'),
  ], new Set(['held']), 105_000);
  assert.deepEqual(ids(waiting), ['kept']);
});

test('the next decision is the first one waiting, or the one after the open task\'s, round to the start; the count leaves the open task out', () => {
  const waiting = waitingOf([
    ask('second', { question: question('q-second', options('A'), 20) }),
    session('your-turn'),
    ask('first', { question: question('q-first', options('A'), 10) }),
    ask('third', { question: question('q-third', options('A'), 30) }),
  ], none);
  const next = (current: string | null) => {
    const { next: n, count } = nextDecision(waiting, current);
    return [n?.id ?? null, count];
  };
  assert.deepEqual(next(null), ['first', 3]);
  assert.deepEqual(next('your-turn'), ['first', 3], 'a task with no decision goes to the first');
  assert.deepEqual(next('answered-meanwhile'), ['first', 3], 'one answered from here no longer waits');
  assert.deepEqual(next('first'), ['second', 2]);
  assert.deepEqual(next('second'), ['third', 2]);
  assert.deepEqual(next('third'), ['first', 2]);
  assert.deepEqual(nextDecision(waitingOf([ask('only')], none), 'only'), { next: null, count: 0 });
  assert.deepEqual(nextDecision(waitingOf([session('your-turn')], none), null), { next: null, count: 0 });
});
