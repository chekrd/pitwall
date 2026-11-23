import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { answering, Called } from './answering.ts';
import type { Session } from './db.ts';
import { claim, decisionKey } from './decision.ts';
import { Unsent, type Target } from './delivery.ts';
import { PartlyTyped, type Keystroke } from './ghostty.ts';
import type { Round } from './rounds.ts';

const session = (patch: Partial<Session>): Session => ({
  id: 's', conversation: 's', history: [], repoId: 1, worktree: '/w', cwd: '/w', pid: 1, tty: '/dev/ttys001', title: null, firstPrompt: null, status: 'idle',
  question: null, diffstat: null, lastMessage: null, lastPrompt: null, unanswered: null, lastTurn: 't2', waitingFor: null,
  dismissedAsk: null, round: null, dismissedRound: null, prs: [], activity: null, menu: null, answered: null, artifacts: [], links: [], model: null, effort: null, context: null, interrupted: null, turnError: null, scheduled: null, starting: null, parked: [], review: { comments: [], outdated: {} }, asides: [], aliveAt: null,
  archived: false, createdAt: 0, updatedAt: 0, ...patch,
});

const ship = { toolUseId: 'q2', title: 'Ship it?', details: 'Tests pass.', options: [{ label: 'Ship' }, { label: 'Wait' }], category: 'plan-problem', askedAt: 5 };
const shipped = 'Re: "Ship it?" — My decision: Ship.';
const question = { toolUseId: 'q1', title: 'Which way?', details: 'd', options: [{ label: 'A' }, { label: 'B' }], category: 'plan-problem', askedAt: 1 };
const menu = { toolUseId: 'm1', at: 2, questions: [{ question: 'Colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] };

// A session behind a fake terminal. With `hold`, each send waits until the test lets it finish or fail; with
// `pressFails`, every press of keys fails with it.
function world(s: Session, { hold = false, pressFails, clearedMs }: { hold?: boolean; pressFails?: Error; clearedMs?: number } = {}) {
  let row = s;
  let notified = 0;
  const typed: string[] = [];
  const pressed: Keystroke[][] = [];
  const targets: Target[] = [];
  const decided: string[] = [];
  const sends: { done: () => void; fail: (err: Error) => void }[] = [];
  const store = { get: (id: string) => (id === row.id ? row : undefined), update: (_: string, patch: Partial<Session>) => void (row = { ...row, ...patch }) };
  const answers = answering({
    store,
    send: (to, text) => {
      targets.push(to);
      typed.push(text);
      return hold ? new Promise((done, fail) => sends.push({ done: () => done(), fail })) : Promise.resolve();
    },
    keys: async (to, strokes) => {
      targets.push(to);
      pressed.push(strokes);
      if (pressFails) throw pressFails;
    },
    notify: () => void notified++,
    decided: (id) => void decided.push(id),
    isCommand: async (_s, text) => text.startsWith('!') || ['/review', '/rpi:rpi'].includes(text.split(' ')[0]),
    checkUploads: async (files) => (files as string[] | undefined) ?? [],
    ...(clearedMs !== undefined && { clearedMs }),
  });
  return { answers, store, row: () => row, notified: () => notified, typed, pressed, targets, decided, sends };
}

test('two answers to one decision at once type once: the second is refused while the first still types', async () => {
  const w = world(session({ question: ship }), { hold: true });
  const first = w.answers.answer('s', { key: 'q:q2', choice: 'Ship' });
  const second = w.answers.answer('s', { key: 'q:q2', choice: 'Ship' });
  await assert.rejects(second, { code: 'answered' });
  assert.deepEqual(w.typed, [shipped]);
  assert.equal(decisionKey(w.row()), null, 'closed before the keys went out');
  assert.equal(w.notified(), 1);
  assert.deepEqual(w.decided, []);
  w.sends[0].done();
  await first;
  assert.deepEqual(w.decided, ['s']);
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text], ['q:q2', 'Ship']);
});

test('a send that fails gives the decision back and rethrows', async () => {
  const w = world(session({ question }), { hold: true });
  const answer = w.answers.answer('s', { key: 'q:q1', choice: 'A', text: 'after lunch' });
  await flush();
  assert.deepEqual(w.typed, ['Re: "Which way?" — My decision: A. — after lunch']);
  w.sends[0].fail(new Error('can\'t find pane'));
  await assert.rejects(answer, /can't find pane/);
  assert.equal(w.row().answered, null);
  assert.equal(decisionKey(w.row()), 'q:q1');
  assert.equal(w.notified(), 2);
});

test('a message sent while an answer to a question types goes out after it, as a message and not as a reply to the question', async () => {
  const w = world(session({ question }), { hold: true });
  const answer = w.answers.answer('s', { key: 'q:q1', choice: 'A' });
  const note = w.answers.answer('s', { key: null, text: 'Also bump the version' });
  await flush();
  assert.deepEqual(w.typed, ['Re: "Which way?" — My decision: A.'], 'one send at a time');
  w.sends[0].done();
  await answer;
  await flush();
  assert.equal(w.typed.at(-1), 'Also bump the version');
  w.sends[1].done();
  await note;
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text, w.decided], ['q:q1', 'Also bump the version', ['s', 's']]);
});

test('a message never closes a question: one sent while the answer types is refused once the answer fails, and the question stays open', async () => {
  const w = world(session({ question }), { hold: true });
  const answer = w.answers.answer('s', { key: 'q:q1', choice: 'A' });
  const note = assert.rejects(w.answers.answer('s', { key: null, text: 'Also bump the version' }), { message: /asked something meanwhile/, code: 'stale' });
  await flush();
  w.sends[0].fail(new Error('can\'t find pane'));
  await assert.rejects(answer, /can't find pane/);
  await flush();
  assert.deepEqual(w.typed, ['Re: "Which way?" — My decision: A.']);
  await note;
  assert.deepEqual([w.row().answered, decisionKey(w.row())], [null, 'q:q1']);
});

test('a send that fails gives back only its own claim: a record written while it typed stays', async () => {
  const w = world(session({}), { hold: true });
  const first = w.answers.answer('s', { key: null, text: 'one' });
  await flush();
  claim(w.store, 's', null, 'two');
  w.sends[0].fail(new Error('the pane is gone'));
  await assert.rejects(first, /the pane is gone/);
  assert.equal(w.row().answered?.text, 'two');
});

test('a command waits for the send that is typing and goes out after it', async () => {
  const w = world(session({ question: ship }), { hold: true });
  const answer = w.answers.answer('s', { key: 'q:q2', choice: 'Ship' });
  const command = w.answers.answer('s', { key: null, text: '/review' });
  await flush();
  assert.deepEqual(w.typed, [shipped]);
  w.sends[0].done();
  await answer;
  await flush();
  w.sends[1].done();
  await command;
  assert.deepEqual([w.typed, w.row().answered?.text], [[shipped, '/review'], 'Ship']);
});

test('a command is typed as is and never claims, whatever the page showed', async () => {
  const w = world(session({ question }));
  await w.answers.answer('s', { key: undefined, text: '/review the cart code' });
  await w.answers.answer('s', { key: 'q:q0', text: '!git status' });
  assert.deepEqual(w.typed, ['/review the cart code', '!git status']);
  assert.equal(w.row().answered, null);
  assert.equal(w.notified(), 0);
});

test('a slash word that is no command, or a command with files, is an answer', async () => {
  const w = world(session({}));
  await w.answers.answer('s', { key: null, text: '/nope is my reply' });
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text, w.typed], [null, '/nope is my reply', ['My reply: /nope is my reply']]);
  await assert.rejects(w.answers.answer('s', { key: undefined, text: '/review', files: ['/u/a.png'] }), { code: 'out-of-date' });
});

test('an answer never reaches Claude Code starting with ! or /, which would run in its shell or as a command', async () => {
  const draft = world(session({}));
  await draft.answers.answer('s', { key: null, text: '!pnpm install && pnpm test' }, false);
  assert.deepEqual([draft.typed, draft.row().answered?.text], [['My reply: !pnpm install && pnpm test'], '!pnpm install && pnpm test']);
  const files = world(session({}));
  await files.answers.answer('s', { key: null, text: '!important: the log', files: ['/u/log.txt'] });
  assert.deepEqual(files.typed, ['My reply: !important: the log']);
});

test('nothing is claimed while Claude shows something in its terminal, or when the session ended', async () => {
  const w = world(session({ status: 'waiting', waitingFor: 'a permission prompt' }));
  await assert.rejects(w.answers.answer('s', { key: null, text: 'Hi' }), /Claude is showing a permission prompt in its terminal/);
  const ended = world(session({ question, status: 'exited' }));
  await assert.rejects(ended.answers.answer('s', { key: 'q:q1', choice: 'A' }), /this session has ended/);
  await assert.rejects(ended.answers.answer('s', {}), /empty answer/);
  assert.deepEqual([w.row().answered, ended.row().answered, w.typed, ended.typed], [null, null, [], []]);
});

test('a menu answer is checked before it is claimed, and two at once press the keys once', async () => {
  const w = world(session({ menu, status: 'waiting' }));
  await assert.rejects(w.answers.answerMenu('s', { toolUseId: 'm0', answers: [{ labels: ['Red'], other: '' }] }), { code: 'stale' });
  await assert.rejects(w.answers.answerMenu('s', { toolUseId: 'm1', answers: [{ labels: ['Green'], other: '' }] }), /unknown option/);
  assert.equal(w.row().answered, null);
  const results = await Promise.allSettled([
    w.answers.answerMenu('s', { toolUseId: 'm1', answers: [{ labels: ['Blue'], other: '' }] }),
    w.answers.answerMenu('s', { toolUseId: 'm1', answers: [{ labels: ['Blue'], other: '' }] }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.deepEqual(w.pressed, [[{ key: 'arrow_down' }, { key: 'enter' }]]);
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text], ['m:m1', 'Colour: Blue']);
});

test('a decline presses Esc only while the menu it names is still open, and once for two at once', async () => {
  const w = world(session({ menu, status: 'waiting' }));
  await assert.rejects(w.answers.declineMenu('s', { toolUseId: 'm0' }), { code: 'stale' });
  assert.deepEqual(w.pressed, []);
  const results = await Promise.allSettled([w.answers.declineMenu('s', { toolUseId: 'm1' }), w.answers.declineMenu('s', { toolUseId: 'm1' })]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.deepEqual(w.pressed, [[{ key: 'escape' }]]);
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text], ['m:m1', 'Declined the question']);
  assert.equal(w.targets[0].prompt, true);
});

test('a menu answer whose keys stopped part way stays answered, since the same keys again would pick from the wrong place; one that typed none is given back', async () => {
  const blue = { toolUseId: 'm1', answers: [{ labels: ['Blue'], other: '' }] };
  const w = world(session({ menu, status: 'waiting' }), { pressFails: new PartlyTyped('tmux failed after 1 of 2 keys') });
  await assert.rejects(w.answers.answerMenu('s', blue), /^Error: the keys stopped part way through Claude's menu; finish it in the terminal$/);
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text, decisionKey(w.row())], ['m:m1', 'Colour: Blue', null]);
  await assert.rejects(w.answers.answerMenu('s', blue), { code: 'answered' });
  assert.equal(w.pressed.length, 1, 'the keys went out once');
  const none = world(session({ menu, status: 'waiting' }), { pressFails: new Error('can\'t find pane: s') });
  await assert.rejects(none.answers.answerMenu('s', blue), /can't find pane/);
  assert.deepEqual([none.row().answered, decisionKey(none.row())], [null, 'm:m1']);
});

test('an answer whose Enter was held back stays answered, as the text waits in the terminal, and says so', async () => {
  const w = world(session({ question }), { hold: true });
  const answer = w.answers.answer('s', { key: 'q:q1', choice: 'A' });
  await flush();
  const held = new Unsent('Claude is showing a permission prompt in its terminal, so Enter was not pressed');
  w.sends[0].fail(held);
  await assert.rejects(answer, (err) => err === held);
  assert.deepEqual([w.row().answered?.key, decisionKey(w.row())], ['q:q1', null]);
});

test("each send names the Claude it is for, by pid, tty and conversation, and only a menu answer may answer Claude's prompt", async () => {
  const w = world(session({ menu, status: 'waiting' }));
  await w.answers.answerMenu('s', { toolUseId: 'm1', answers: [{ labels: ['Red'], other: '' }] });
  const typing = world(session({}));
  await typing.answers.type('s', '/rename Cart merge');
  assert.deepEqual([...w.targets, ...typing.targets], [
    { pid: 1, tty: '/dev/ttys001', conversation: 's', prompt: true },
    { pid: 1, tty: '/dev/ttys001', conversation: 's', prompt: false },
  ]);
});

test('keys pressed while a send types, such as the Esc of a pause, wait for it to finish', async () => {
  const w = world(session({ status: 'working' }), { hold: true });
  const note = w.answers.answer('s', { key: null, text: 'Also bump the version' });
  await flush();
  const esc = w.answers.press('s', [{ key: 'escape' }]);
  await flush();
  assert.deepEqual(w.pressed, [], 'not between the paste and its Enter');
  w.sends[0].done();
  await note;
  await esc;
  assert.deepEqual(w.pressed, [[{ key: 'escape' }]]);
});

test('a send no longer wanted when its turn comes types nothing', async () => {
  const w = world(session({ question: ship }), { hold: true });
  const answer = w.answers.answer('s', { key: 'q:q2', choice: 'Ship' });
  await flush();
  let wanted = true;
  const pause = w.answers.type('s', 'Pausing', () => wanted);
  const drafts = w.answers.answer('s', { key: null, text: 'Later' }, false, () => wanted);
  wanted = false;
  w.sends[0].done();
  await answer;
  await assert.rejects(pause, Called);
  await assert.rejects(drafts, Called);
  assert.deepEqual(w.typed, [shipped]);
});

test('a rename sent while an answer types goes out after it, and claims nothing', async () => {
  const w = world(session({ question: ship }), { hold: true });
  const answer = w.answers.answer('s', { key: 'q:q2', choice: 'Ship' });
  await flush();
  const rename = w.answers.type('s', '/rename Cart merge');
  await flush();
  assert.deepEqual(w.typed, [shipped], 'not inside the answer\'s paste');
  w.sends[0].done();
  await answer;
  await flush();
  assert.deepEqual(w.typed, [shipped, '/rename Cart merge']);
  w.sends[1].done();
  await rename;
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text, w.decided, w.notified()], ['q:q2', 'Ship', ['s'], 1]);
});

test('typing that answers nothing is checked when its turn comes: a prompt Claude showed meanwhile, or an ended session, refuses it', async () => {
  const w = world(session({ question: ship }), { hold: true });
  const answer = w.answers.answer('s', { key: 'q:q2', choice: 'Ship' });
  await flush();
  const rename = assert.rejects(w.answers.type('s', '/rename Cart merge'), /Claude is showing a permission prompt in its terminal/);
  await flush();
  w.store.update('s', { status: 'waiting', waitingFor: 'a permission prompt' });
  w.sends[0].done();
  await answer;
  await rename;
  assert.deepEqual(w.typed, [shipped]);
  const ended = world(session({ status: 'exited' }));
  await assert.rejects(ended.answers.type('s', '/rename Cart merge'), /this session has ended/);
  assert.deepEqual(ended.typed, []);
});

test('settled waits for the send that types and the one queued behind it, and for one that hangs only until its cap', async () => {
  const w = world(session({ question: ship }), { hold: true });
  await w.answers.settled('s', 60_000);
  const answer = w.answers.answer('s', { key: 'q:q2', choice: 'Ship' });
  const note = w.answers.answer('s', { key: null, text: 'Also bump the version' });
  await flush();
  assert.deepEqual(w.typed, [shipped]);
  let open = false;
  const settled = w.answers.settled('s', 60_000).then(() => void (open = true));
  await flush();
  assert.equal(open, false, 'the answer types');
  w.sends[0].done();
  await answer;
  await flush();
  assert.deepEqual([w.typed.length, open], [2, false], 'the note types now');
  w.sends[1].done();
  await note;
  await settled;
  assert.equal(open, true);
  const hung = w.answers.answer('s', { key: null, text: 'One more' });
  await flush();
  const started = Date.now();
  await w.answers.settled('s', 50);
  assert.ok(Date.now() - started >= 40, 'the cap, not the send, ended the wait');
  w.sends[2].done();
  await hung;
});

test('dismiss closes the decision the page showed and types nothing', () => {
  const w = world(session({ question }));
  assert.throws(() => w.answers.dismiss('s', 'q:q0'), { code: 'stale' });
  assert.throws(() => w.answers.dismiss('s', undefined), { code: 'out-of-date' });
  w.answers.dismiss('s', 'q:q1');
  assert.deepEqual([w.decided, w.typed, w.row().answered, w.row().question, w.row().dismissedAsk], [['s'], [], null, null, 'q1']);
  assert.throws(() => w.answers.dismiss('gone', 'q:q1'), /unknown session gone/);
});

test('an answered question is put aside for good; a menu answered while it is open too leaves it, to come up once the menu closes', async () => {
  const w = world(session({ question }));
  await w.answers.answer('s', { key: 'q:q1', choice: 'A' });
  assert.deepEqual([w.row().question, w.row().dismissedAsk], [null, 'q1']);
  const both = world(session({ question, menu, status: 'waiting' }));
  assert.equal(decisionKey(both.row()), 'm:m1');
  await both.answers.answerMenu('s', { toolUseId: 'm1', answers: [{ labels: ['Blue'], other: '' }] });
  assert.deepEqual([both.row().question?.toolUseId, both.row().dismissedAsk], ['q1', null]);
  both.store.update('s', { menu: null, status: 'idle' });
  assert.equal(decisionKey(both.row()), 'q:q1');
});

const round: Round = {
  key: 'r1', source: 'tool', title: 'Round 1', intro: '', at: 3,
  questions: [
    { id: 'Q1', title: 'Audience', body: 'Who is it for?', options: [{ label: 'Only me' }, { label: 'Friends' }], recommendation: 'Only you.', recommended: 'Only me' },
    { id: 'Q2', title: 'Sources', body: 'Which sources?', options: [], recommendation: '', recommended: null },
  ],
};

test('the answers to a round go out as one message; the round is put aside for good, and a second send of it is refused', async () => {
  const w = world(session({ round }));
  await w.answers.answerRound('s', { round: 'r1', replies: { Q1: { option: 'Only me', recommended: false, text: 'for now' } } });
  assert.deepEqual(w.typed, ['My answers to your questions:\n\nQ1 — Audience: Only me — for now\n\nQ2 — Sources: not answered yet; keep it open']);
  assert.deepEqual([w.row().round, w.row().dismissedRound, w.row().answered?.key, w.row().answered?.text], [null, 'r1', 'r:r1', 'Answers to 1 of 2 questions']);
  await assert.rejects(w.answers.answerRound('s', { round: 'r1', replies: { Q2: { option: null, recommended: false, text: 'x' } } }), { code: 'answered' });
  assert.equal(w.typed.length, 1);
});

test('answers to a round that is no longer the open one, or that answer nothing, type nothing and leave it open', async () => {
  const own = { option: null, recommended: false, text: 'x' };
  const w = world(session({ round }));
  await assert.rejects(w.answers.answerRound('s', { round: 'r0', replies: { Q1: own } }), { code: 'stale' });
  await assert.rejects(w.answers.answerRound('s', { round: 'r1', replies: {} }), /answer at least one question/);
  await assert.rejects(w.answers.answerRound('s', { round: 'r1', replies: { Q1: { ...own, option: 'Strangers' } } }), /unknown option for Q1/);
  assert.deepEqual([w.typed, decisionKey(w.row())], [[], 'r:r1']);
});

test('a reply written instead of the answers closes the round, and Dismiss puts it aside without typing', async () => {
  const w = world(session({ round }));
  await w.answers.answer('s', { key: 'r:r1', text: 'Skip the questions and build it.' });
  assert.deepEqual([w.typed, w.row().round, w.row().dismissedRound], [['Skip the questions and build it.'], null, 'r1']);
  const d = world(session({ round }));
  d.answers.dismiss('s', 'r:r1');
  assert.deepEqual([d.typed, d.row().round, d.row().dismissedRound, decisionKey(d.row())], [[], null, 'r1', null]);
});

const RESEARCH = '/rpi:rpi research .pitwall/artifacts/csv-export; flow: prd';

test('a command in a fresh conversation types /clear, waits for the conversation it starts, then types the command into it, nothing typed between', async () => {
  const w = world(session({ conversation: 'c1' }), { hold: true });
  const sent = w.answers.answer('s', { key: null, text: RESEARCH, fresh: true });
  const other = w.answers.answer('s', { key: null, text: 'And the README' });
  await flush();
  assert.deepEqual(w.typed, ['/clear']);
  w.sends[0].done();
  await new Promise((done) => setTimeout(done, 250));
  assert.deepEqual(w.typed, ['/clear'], 'not before Claude has taken it');
  w.store.update('s', { conversation: 'c2' });
  await new Promise((done) => setTimeout(done, 150));
  assert.deepEqual(w.typed, ['/clear', RESEARCH]);
  assert.deepEqual(w.targets.map((t) => t.conversation), ['c1', 'c2'], 'the command goes to the new conversation');
  w.sends[1].done();
  await sent;
  await flush();
  assert.deepEqual(w.typed, ['/clear', RESEARCH, 'And the README'], 'another send waits for both');
  w.sends[2].done();
  await other;
});

test('a /clear that fails, or that Claude never takes, sends nothing more', async () => {
  const failing = world(session({ conversation: 'c1' }), { hold: true });
  const sent = failing.answers.answer('s', { key: null, text: RESEARCH, fresh: true });
  await flush();
  failing.sends[0].fail(new Error("can't find pane"));
  await assert.rejects(sent, /can't find pane/);
  assert.deepEqual(failing.typed, ['/clear']);

  const ignored = world(session({ conversation: 'c1' }), { clearedMs: 300 });
  await assert.rejects(ignored.answers.answer('s', { key: null, text: RESEARCH, fresh: true }),
    { message: `Claude did not start a new conversation after /clear, so “${RESEARCH}” was not sent` });
  assert.deepEqual(ignored.typed, ['/clear']);

  const ended = world(session({ conversation: 'c1' }), { hold: true });
  const gone = ended.answers.answer('s', { key: null, text: RESEARCH, fresh: true });
  await flush();
  ended.store.update('s', { conversation: 'c2', status: 'exited' });
  ended.sends[0].done();
  await assert.rejects(gone, /this session has ended/);
  assert.deepEqual(ended.typed, ['/clear']);
});

test('only a command starts in a fresh conversation; a message is refused untyped', async () => {
  const w = world(session({}));
  await assert.rejects(w.answers.answer('s', { key: null, text: 'Research it', fresh: true }), /only a command/);
  assert.deepEqual(w.typed, []);
});
