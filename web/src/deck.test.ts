import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  arrivals, choose, deckOf, dismissal, isCommand, kindOf, meter, METER_SEGMENTS, primary, promptOf, resolveFront, rotate, startPicks,
  successor, targetOf, togglePick, typed, type Composer,
} from './deck.ts';
import { menu, options, question, session } from './testing.ts';
import type { Command, Session } from './types.ts';

const ids = (list: readonly { id: string }[]) => list.map((s) => s.id);
const none = new Set<string>();

const ask = (id: string, patch: Partial<Session> = {}) => session(id, { question: question(`q-${id}`), ...patch });

const cart = ask('cart');
const answeredMenu = (at: number) => session('hooks', { status: 'waiting', menu: menu('m1'), answered: { key: 'm:m1', text: 'Backoff: Linear', at } });

test('the deck: decisions, the longest waiting first; then Needs focus, then Your turn', () => {
  const deck = deckOf([
    session('your-turn', { createdAt: 1 }),
    session('needs-focus', { status: 'waiting', waitingFor: 'permission prompt' }),
    session('late', { question: question('q-late', options('A'), 30) }),
    session('early', { question: question('q-early', options('A'), 10) }),
    session('menu', { status: 'waiting', menu: { ...menu('m1'), at: 20 } }),
  ], none);
  assert.deepEqual(ids(deck), ['early', 'menu', 'late', 'needs-focus', 'your-turn']);
});

test('the deck leaves out archived, working, ended and busy sessions, an ended one with an open question, and an answered menu still open', () => {
  const deck = deckOf([
    ask('archived', { archived: true }),
    session('working', { status: 'working' }),
    session('ended', { status: 'exited' }),
    ask('gone', { status: 'exited' }),
    ask('held'),
    answeredMenu(100_000),
    ask('kept'),
  ], new Set(['held']), 105_000);
  assert.deepEqual(ids(deck), ['kept']);
});

test('a menu still open 10 s after the board answered it comes back as Needs focus: Claude still shows it in the terminal', () => {
  const stuck = answeredMenu(100_000);
  assert.deepEqual(ids(deckOf([stuck], none, 110_000)), ['hooks']);
  assert.equal(kindOf(stuck, 110_000), 'prompt');
  assert.deepEqual(promptOf(stuck, 110_000), { headline: 'Claude still shows its menu in the terminal', subject: null });
  assert.deepEqual(primary(stuck, {}, 110_000).press, { intent: 'terminal' });
});

test('the kind of a card: menu, ask, Needs focus or Your turn, also when the turn ended asking something in plain text', () => {
  assert.equal(kindOf(session('s', { status: 'waiting', menu: menu('m1') })), 'menu');
  assert.equal(kindOf(cart), 'ask');
  assert.equal(kindOf(session('s', { lastMessage: 'Ship it?' })), 'idle');
  assert.equal(kindOf(session('s', { status: 'waiting' })), 'prompt');
  assert.equal(kindOf(session('s')), 'idle');
  assert.equal(kindOf(session('s', { status: 'working' })), null);
});

test('the Needs-focus card names what the terminal shows, and its subject when there is one', () => {
  assert.deepEqual(promptOf(session('s', { status: 'waiting', waitingFor: 'a permission prompt for Bash: pnpm test' })), {
    headline: 'Claude is showing a permission prompt for Bash: pnpm test in its terminal', subject: 'Bash: pnpm test',
  });
  assert.deepEqual(promptOf(session('s', { status: 'waiting', waitingFor: 'its start-up prompt' })), {
    headline: 'Claude is showing its start-up prompt in its terminal', subject: null,
  });
});

test('rotate turns the deck to its front card, round to the start, with a send that failed right after the front', () => {
  const deck = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  assert.deepEqual(ids(rotate(deck, 'c')), ['c', 'd', 'a', 'b']);
  assert.deepEqual(ids(rotate(deck, 'c', new Set(['b']))), ['c', 'b', 'd', 'a']);
  assert.deepEqual(ids(rotate(deck, 'c', new Set(['c']))), ['c', 'd', 'a', 'b']);
  assert.deepEqual(ids(rotate(deck, 'gone')), ['a', 'b', 'c', 'd']);
  assert.deepEqual(rotate([], 'a'), []);
});

test('successor: the card after the leaving one in the order last shown, passing over cards that left too, round to the start', () => {
  const last = ['c', 'd', 'a', 'b'];
  const deck = (...list: string[]) => list.map((id) => ({ id }));
  assert.equal(successor(last, 'c', deck('a', 'b', 'd')), 'd');
  assert.equal(successor(last, 'c', deck('a', 'b')), 'a');
  assert.equal(successor(last, 'b', deck('a', 'd')), 'd', 'it wraps');
  assert.equal(successor(last, 'x', deck('a', 'b')), 'a', 'one never shown starts from the front of the order');
  assert.equal(successor(last, 'c', deck('new')), 'new', 'nothing shown is left');
  assert.equal(successor(last, 'c', []), null);
});

test('the front card: the pinned one while it is in the deck, else the one that followed it, else the first', () => {
  const deck = ['a', 'b', 'c'].map((id) => ({ id }));
  assert.equal(resolveFront(deck, 'b', ['b', 'c', 'a']), 'b');
  assert.equal(resolveFront(deck.filter((s) => s.id !== 'b'), 'b', ['b', 'c', 'a']), 'c');
  assert.equal(resolveFront(deck, null, []), 'a');
  assert.equal(resolveFront([], 'b', ['b']), null);
});

test('arrivals: decisions new since the page loaded and not yet shown, newest first; a new decision on the front card is an update', () => {
  const deck = [
    ask('seeded'),
    session('first', { question: question('q-first', options('A'), 5) }),
    session('second', { question: question('q-second', options('A'), 9) }),
    session('front', { question: question('q-front2') }),
    session('your-turn'),
  ];
  const seen = new Set(['q:q-seeded', 'q:q-front']);
  assert.deepEqual(ids(arrivals(deck, seen, 'front')), ['second', 'first']);
  assert.deepEqual(ids(arrivals(deck, new Set([...seen, 'q:q-second', 'q:q-front2']), 'first')), [], 'each key shown at the front counts as seen');
});

const closed: Composer = { open: false, text: '', files: [] };
const open = (text: string, files: string[] = [], uploading = false): Composer => ({ open: true, text, files, uploading });

test('the primary on an ask card sends the option Claude recommends, with the open composer\'s note', () => {
  const s = session('s', { question: question('q1', [{ label: 'Keep' }, { label: 'Merge', recommended: true }]) });
  const merge = { action: 'answer', body: { key: 'q:q1', choice: 'Merge' }, label: 'Merge' };
  assert.deepEqual(primary(s, { composer: closed }), { label: 'Send “Merge”', disabled: false, press: merge });
  assert.deepEqual(primary(s, { composer: open('  ') }).press, merge, 'an empty composer adds nothing');
  assert.deepEqual(primary(s, { composer: { ...closed, text: 'hidden draft' } }).press, merge, 'a closed composer sends nothing unseen');
  assert.deepEqual(primary(s, { composer: open(' only if stock allows ', ['/u/a.png']) }), {
    label: 'Send “Merge” + your note', disabled: false,
    press: { action: 'answer', body: { key: 'q:q1', choice: 'Merge', text: 'only if stock allows', files: ['/u/a.png'] }, label: 'Merge' },
  });
  assert.deepEqual(primary(s, { composer: open('', ['/u/a.png']) }).press, { action: 'answer', body: { key: 'q:q1', choice: 'Merge', files: ['/u/a.png'] }, label: 'Merge' });
  assert.equal(primary(s, { composer: open('note', [], true) }).disabled, true, 'an attachment still uploading');
  assert.equal(primary(s, { composer: { ...closed, uploading: true } }).disabled, false, 'an upload in a closed composer goes nowhere');
  const plain = session('s', { question: question('q1') });
  assert.deepEqual(primary(plain), { label: 'Pick an option', disabled: true, press: null });
  assert.deepEqual(primary(plain, { composer: open('my own answer') }), { label: 'Pick an option', disabled: true, press: null },
    'the primary never sends the composer\'s text by itself');
  assert.deepEqual(primary(session('s', { question: question('q1', []) })), { label: 'Reply', disabled: false, press: { intent: 'compose' } }, 'no options to pick from');
});

test('the primary on a menu sends the picks on screen once every question has one', () => {
  const s = session('m', { status: 'waiting', menu: menu('m1') });
  const mine = [{ labels: [], other: 'Every hour' }, { labels: ['Log'], other: '' }];
  assert.deepEqual(primary(s, { picks: mine }), {
    label: 'Send answer', disabled: false,
    press: { action: 'answer-menu', body: { toolUseId: 'm1', answers: mine }, label: 'Backoff: Every hour · Give up: Log' },
  });
  assert.deepEqual(primary(s, { picks: [mine[0], { labels: [], other: '' }] }), { label: 'Answer both questions', disabled: true, press: null });
  assert.deepEqual(primary(s), { label: 'Answer both questions', disabled: true, press: null }, 'none picked yet');
  const lone = session('l', { status: 'waiting', menu: menu('m2', { question: 'Backoff?', header: 'Backoff', multiSelect: false, options: options('A', 'B') }) });
  assert.deepEqual(primary(lone), { label: 'Pick an option', disabled: true, press: null });
});

test('the primary on Needs focus opens the terminal, and on Your turn it is Reply, which focuses the composer', () => {
  assert.deepEqual(primary(session('s', { status: 'waiting' })), { label: 'Terminal', disabled: false, press: { intent: 'terminal' } });
  assert.deepEqual(primary(session('s'), { composer: open('Thanks') }), { label: 'Reply', disabled: false, press: { intent: 'compose' } });
});

test('the target ⏎ sends: the recommended option, nothing, or the terminal; a note typed does not change it', () => {
  assert.equal(targetOf(session('s', { question: question('q1', [{ label: 'Keep', recommended: true }]) })), 'choice:Keep');
  assert.equal(targetOf(session('s', { question: question('q1') })), 'none');
  assert.equal(targetOf(session('s', { status: 'waiting' })), 'terminal');
});

test('an option pressed answers with it, and with the open composer\'s note', () => {
  const s = session('s', { question: question('q1') });
  assert.deepEqual(choose(s, 'Merge', closed), { action: 'answer', body: { key: 'q:q1', choice: 'Merge' }, label: 'Merge' });
  assert.deepEqual(choose(s, 'Merge', open('only if in stock')), { action: 'answer', body: { key: 'q:q1', choice: 'Merge', text: 'only if in stock' }, label: 'Merge' });
  assert.deepEqual(choose(s, 'Keep'), { action: 'answer', body: { key: 'q:q1', choice: 'Keep' }, label: 'Keep' });
});

test('no option sends while an attachment in the open composer is still uploading, which the send would leave out', () => {
  const s = session('s', { question: question('q1') });
  assert.equal(choose(s, 'Keep', open('see the screenshot', [], true)), null);
  assert.equal(choose(s, 'Merge', open('', [], true)), null);
  assert.equal(choose(s, 'Keep', open('see both', ['/u/a.png'], true)), null);
  assert.deepEqual(choose(s, 'Keep', { ...closed, uploading: true }), { action: 'answer', body: { key: 'q:q1', choice: 'Keep' }, label: 'Keep' });
});

test('a draft counts as a command only once the command list has loaded, and the way the server tells them', () => {
  const commands: Command[] = [{ name: 'compact', description: '' }, { name: 'plugin:review', description: '' }];
  assert.equal(isCommand('/compact', 0, null), false);
  assert.equal(isCommand('!git status', 0, null), false);
  assert.equal(isCommand('/compact', 0, commands), true);
  assert.equal(isCommand('/plugin:review 12', 0, commands), true);
  assert.equal(isCommand('!git status', 0, commands), true);
  assert.equal(isCommand('/etc/hosts is wrong', 0, commands), false);
  assert.equal(isCommand('/compact', 1, commands), false, 'with a file it is a message');
  assert.deepEqual(typed('q:q1', ' /compact ', [], commands), { action: 'answer', body: { key: 'q:q1', text: '/compact' }, label: '/compact', command: true });
  assert.deepEqual(typed('q:q1', '/compact', [], null), { action: 'answer', body: { key: 'q:q1', text: '/compact' }, label: '/compact' });
});

test('what Enter in a composer sends: an answer to the card\'s decision, or a plain message with an explicit null key', () => {
  assert.deepEqual(typed('q:q1', ' Use the cache ', ['/u/a.png'], []), { action: 'answer', body: { key: 'q:q1', text: 'Use the cache', files: ['/u/a.png'] }, label: 'Use the cache' });
  assert.deepEqual(typed(null, 'Thanks', [], []), { action: 'answer', body: { key: null, text: 'Thanks' }, label: 'Thanks' });
  assert.deepEqual(typed(null, '', ['/u/a.png', '/u/b.png'], []).label, '2 files');
  assert.deepEqual(dismissal(cart), { action: 'dismiss', body: { key: 'q:q-cart' }, label: 'Which cart wins?' });
});

test('the meter: one segment per card up to 20, then one bar per group with its count', () => {
  const crowd = (decide: number, focus: number, idle: number) => [
    ...Array.from({ length: decide }, (_, i) => session(`d${i}`, { question: question(`q-d${i}`, options('A'), i) })),
    ...Array.from({ length: focus }, (_, i) => session(`f${i}`, { status: 'waiting', createdAt: i })),
    ...Array.from({ length: idle }, (_, i) => session(`i${i}`, { createdAt: i })),
  ];
  const twenty = crowd(12, 3, 5);
  const at20 = meter(twenty, 'd3', new Set(['f1']));
  assert.equal(METER_SEGMENTS, 20);
  assert.equal(at20.segments?.length, 20);
  assert.equal(at20.bars, null);
  assert.deepEqual(at20.segments?.filter((s) => s.current || s.arrived).map((s) => [s.id, s.current, s.arrived]), [['d3', true, false], ['f1', false, true]]);
  assert.deepEqual([at20.label, at20.position, at20.total], ['12 decisions · 3 terminal prompts · 5 finished turns', 4, 20]);

  const at21 = meter(crowd(13, 3, 5), 'f2');
  assert.equal(at21.segments, null);
  assert.deepEqual(at21.bars?.map((b) => [b.attention, b.count, b.current, b.target]), [['decide', 13, false, 'd0'], ['focus', 3, true, 'f0'], ['idle', 5, false, 'i0']]);

  const at45 = meter(crowd(30, 5, 10), 'd29', new Set(['i4']));
  assert.deepEqual(at45.bars?.map((b) => [b.count, b.current, b.arrived, b.target]), [[30, true, false, 'd0'], [5, false, false, 'f0'], [10, false, true, 'i0']]);
  assert.equal(meter(crowd(30, 5, 10), 'd4').bars?.[0].target, 'd5', 'within the front card\'s group, the next card');
  assert.deepEqual([meter(crowd(1, 0, 1), null).label, meter([], null).label], ['1 decision · 1 finished turn', '']);
});

test('a menu\'s picks start as made on it before, else empty, as copies the view can change; a press toggles in a pick-any question and picks or clears in a pick-one question', () => {
  const kept = [{ labels: ['Linear'], other: '' }, { labels: ['Email'], other: '' }];
  const start = startPicks(kept, menu('m1'));
  assert.deepEqual(start, kept);
  start[0].labels.push('Exponential');
  assert.deepEqual(kept[0].labels, ['Linear'], 'the kept picks changed with the view');
  assert.deepEqual(startPicks(null, menu('m1')), [{ labels: [], other: '' }, { labels: [], other: '' }]);
  assert.deepEqual(startPicks(null, null), []);

  const picks = [{ labels: ['Linear'], other: '' }, { labels: ['Email'], other: '' }];
  assert.deepEqual(togglePick(picks, 0, 'Exponential', false), [{ labels: ['Exponential'], other: '' }, picks[1]]);
  assert.deepEqual(togglePick(picks, 0, 'Linear', false), [{ labels: [], other: '' }, picks[1]]);
  assert.deepEqual(togglePick([{ labels: [], other: 'Custom' }], 0, 'Linear', false), [{ labels: ['Linear'], other: '' }], 'a pick replaces an own answer');
  assert.deepEqual(togglePick(picks, 1, 'Log', true), [picks[0], { labels: ['Email', 'Log'], other: '' }]);
  assert.deepEqual(togglePick(picks, 1, 'Email', true), [picks[0], { labels: [], other: '' }]);
});

const round = {
  key: 'r1', source: 'tool' as const, title: 'Round 1', intro: '', at: 3,
  questions: [
    { id: 'Q1', title: 'Audience', body: 'Who?', options: [{ label: 'Only me' }, { label: 'Friends' }], recommendation: 'Only you.', recommended: 'Only me' },
    { id: 'Q2', title: 'Sources', body: 'Which?', options: [], recommendation: '', recommended: null },
  ],
};

test('a round of questions is a card of its own: its main button counts the answers and sends the ones given, and Dismiss names the round', () => {
  const s = session('events', { round });
  assert.equal(kindOf(s), 'round');
  assert.deepEqual(primary(s), { label: 'Answer a question', disabled: true, press: null });
  assert.equal(targetOf(s), 'none');
  const q1 = { option: 'Only me', recommended: false, text: '' };
  const blank = { option: null, recommended: false, text: ' ' };
  assert.deepEqual(primary(s, { replies: { Q1: q1, Q2: blank } }), {
    label: 'Send 1 of 2 answers', disabled: false,
    press: { action: 'answer-round', body: { round: 'r1', replies: { Q1: q1 } }, label: 'Answers to 1 of 2 questions' },
  });
  assert.equal(primary(s, { replies: { Q1: q1, Q2: { ...blank, text: 'the city calendar' } } }).label, 'Send all 2 answers');
  assert.equal(primary(session('one', { round: { ...round, questions: round.questions.slice(0, 1) } }), { replies: { Q1: q1 } }).label, 'Send answer');
  assert.deepEqual(dismissal(s), { action: 'dismiss', body: { key: 'r:r1' }, label: 'Round 1' });
  assert.deepEqual(ids(deckOf([s], none)), ['events']);
});
