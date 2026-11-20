import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choose, dismissal, isCommand, kindOf, primary, promptOf, startPicks, targetOf, togglePick, typed, type Composer } from './answers.ts';
import { waitingOf } from './order.ts';
import { menu, options, question, session } from './testing.ts';
import type { Command, Session } from './types.ts';

const ids = (list: readonly { id: string }[]) => list.map((s) => s.id);
const none = new Set<string>();

const ask = (id: string, patch: Partial<Session> = {}) => session(id, { question: question(`q-${id}`), ...patch });

const cart = ask('cart');
const answeredMenu = (at: number) => session('hooks', { status: 'waiting', menu: menu('m1'), answered: { key: 'm:m1', text: 'Backoff: Linear', at } });

test('a menu still open 10 s after the board answered it comes back as Needs focus: Claude still shows it in the terminal', () => {
  const stuck = answeredMenu(100_000);
  assert.deepEqual(ids(waitingOf([stuck], none, 110_000)), ['hooks']);
  assert.equal(kindOf(stuck, 110_000), 'prompt');
  assert.deepEqual(promptOf(stuck, 110_000), { headline: 'Claude still shows its menu in the terminal', subject: null });
  assert.deepEqual(primary(stuck, {}, 110_000).press, { intent: 'terminal' });
});

test('the kind of what a task waits for: menu, ask, Needs focus or Your turn, also when the turn ended asking something in plain text', () => {
  assert.equal(kindOf(session('s', { status: 'waiting', menu: menu('m1') })), 'menu');
  assert.equal(kindOf(cart), 'ask');
  assert.equal(kindOf(session('s', { lastMessage: 'Ship it?' })), 'idle');
  assert.equal(kindOf(session('s', { status: 'waiting' })), 'prompt');
  assert.equal(kindOf(session('s')), 'idle');
  assert.equal(kindOf(session('s', { status: 'working' })), null);
});

test('Needs focus names what the terminal shows, and its subject when there is one', () => {
  assert.deepEqual(promptOf(session('s', { status: 'waiting', waitingFor: 'a permission prompt for Bash: pnpm test' })), {
    headline: 'Claude is showing a permission prompt for Bash: pnpm test in its terminal', subject: 'Bash: pnpm test',
  });
  assert.deepEqual(promptOf(session('s', { status: 'waiting', waitingFor: 'its start-up prompt' })), {
    headline: 'Claude is showing its start-up prompt in its terminal', subject: null,
  });
});

const closed: Composer = { open: false, text: '', files: [] };
const open = (text: string, files: string[] = [], uploading = false): Composer => ({ open: true, text, files, uploading });

test('the primary on an ask sends the option Claude recommends, with the open composer\'s note', () => {
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
  assert.equal(isCommand('/review 12', 0, commands), true, "a plugin's command by its bare name");
  assert.equal(isCommand('!git status', 0, commands), true);
  assert.equal(isCommand('/etc/hosts is wrong', 0, commands), false);
  assert.equal(isCommand('/compact', 1, commands), false, 'with a file it is a message');
  assert.deepEqual(typed('q:q1', ' /compact ', [], commands), { action: 'answer', body: { key: 'q:q1', text: '/compact' }, label: '/compact', command: true });
  assert.deepEqual(typed('q:q1', '/compact', [], null), { action: 'answer', body: { key: 'q:q1', text: '/compact' }, label: '/compact' });
});

test('what Enter in a composer sends: an answer to the decision it shows, or a plain message with an explicit null key', () => {
  assert.deepEqual(typed('q:q1', ' Use the cache ', ['/u/a.png'], []), { action: 'answer', body: { key: 'q:q1', text: 'Use the cache', files: ['/u/a.png'] }, label: 'Use the cache' });
  assert.deepEqual(typed(null, 'Thanks', [], []), { action: 'answer', body: { key: null, text: 'Thanks' }, label: 'Thanks' });
  assert.deepEqual(typed(null, '', ['/u/a.png', '/u/b.png'], []).label, '2 files');
  assert.deepEqual(dismissal(cart), { action: 'dismiss', body: { key: 'q:q-cart' }, label: 'Which cart wins?' });
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

test('a round of questions is a decision of its own: its main button counts the answers and sends the ones given, and Dismiss names the round', () => {
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
  assert.deepEqual(ids(waitingOf([s], none)), ['events']);
});
