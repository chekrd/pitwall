import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutQuote, documentCommentsMessage, draftMessage, MAX_QUOTE } from './codeRef.ts';
import { actionBodies } from './contract.ts';
import type { Parked, Session } from './db.ts';
import { addParked, editParked, endsOnQuestion, removeParked, turnEnds } from './parked.ts';

const session = (patch: Partial<Session>): Session => ({
  id: 's', conversation: 's', history: [], repoId: 1, worktree: '/w', cwd: '/w', pid: 1, tty: '/dev/ttys1', title: null, firstPrompt: null, status: 'working',
  question: null, diffstat: null, lastMessage: null, lastPrompt: null, unanswered: null, lastTurn: 't2', waitingFor: null,
  dismissedAsk: null, round: null, dismissedRound: null, prs: [], activity: null, menu: null, answered: null, artifacts: [], links: [], model: null, effort: null, context: null, interrupted: null, turnError: null, scheduled: null, starting: null, parked: [], asides: [], aliveAt: null,
  archived: false, createdAt: 0, updatedAt: 0, ...patch,
});

const draft = (id: string, armedAt: number | null, text = id): Parked => ({ id, text, auto: armedAt !== null, armedAt, at: 0 });

const done = 'Done: the cart merges both carts now.';

// A turn that ran from 100 and ended at 200 on a reply that asks nothing, the drafts armed at 150.
function ended(patch: Partial<Session> = {}, parked = [draft('a', 150, 'First'), draft('b', 160, 'Second')]) {
  const w = turnEnds();
  assert.deepEqual(w.observe([session({ parked })], [], 100), []);
  return { w, idle: session({ status: 'idle', parked, lastMessage: done, ...patch }) };
}

test('drafts armed during a turn go out one per turn: the first when it ends, the next when the turn it started ends', () => {
  const { w, idle } = ended();
  assert.deepEqual(w.observe([idle], [], 200), [{ id: 's', ids: ['a'], text: 'First' }]);
  const left = [draft('b', 160, 'Second')];
  assert.deepEqual(w.observe([{ ...idle, parked: left }], [], 300), [], 'the end was used up');
  const answered = { key: null, text: 'First', at: 200 };
  assert.deepEqual(w.observe([session({ parked: left, answered })], [], 400), []);
  assert.deepEqual(w.observe([session({ status: 'idle', parked: left, answered, lastTurn: 't3', lastMessage: done })], [], 500), [{ id: 's', ids: ['b'], text: 'Second' }]);
});

test('only drafts armed to send are sent, not the ones kept for a press', () => {
  const { w, idle } = ended({}, [draft('k', null), draft('a', 150), draft('b', 160)]);
  assert.deepEqual(w.observe([idle], [], 200)[0].ids, ['a']);
});

test('a draft armed while it is already your turn goes out at once, with the same holds as at the end of a turn', () => {
  const { w, idle } = ended({}, []);
  assert.deepEqual(w.observe([idle], [], 200), []);
  const late = { ...idle, parked: [draft('late', 250, 'Late')] };
  assert.deepEqual(w.observe([late], [], 260), [], 'not without having been armed');
  w.armed(late, 250);
  assert.deepEqual(w.observe([late], [], 260), [{ id: 's', ids: ['late'], text: 'Late' }]);
  const fresh = turnEnds();
  const board = session({ status: 'idle', parked: [draft('a', 300)], lastMessage: done });
  fresh.armed(board, 300);
  assert.deepEqual(fresh.observe([board], [], 300).length, 1, 'also on a task the board never saw work');
  const decided = turnEnds();
  const asked = { ...board, lastMessage: 'Should I ship it?' };
  decided.armed(asked, 300);
  assert.deepEqual(decided.observe([asked], [], 300), [], 'not onto a question the turn ended on');
  const working = turnEnds();
  working.armed(session({ parked: [draft('a', 300)] }), 300);
  assert.deepEqual(working.observe([session({ parked: [draft('a', 300)] })], [], 310), [], 'while Claude works it waits');
});

test('no end of turn without having seen Claude work: a board that starts on an idle task sends nothing', () => {
  const w = turnEnds();
  assert.deepEqual(w.observe([session({ status: 'idle', parked: [draft('a', 1)], lastMessage: done })], [], 200), []);
});

test('a permission prompt or a menu is not the end of a turn', () => {
  const w = turnEnds();
  const parked = [draft('a', 50)];
  w.observe([session({ parked })], [], 100);
  assert.deepEqual(w.observe([session({ status: 'waiting', parked })], [], 150), []);
  assert.deepEqual(w.observe([session({ status: 'idle', parked, lastMessage: done })], [], 160), []);
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

test('a turn that ended on a question, in its reply or as a question, menu or round, keeps its drafts for the next end', () => {
  const { w, idle } = ended({ lastMessage: 'I found two ways.\n\nShould I merge the carts or keep them apart?' });
  assert.deepEqual(w.observe([idle], [], 200), []);
  assert.deepEqual(w.observe([idle], [], 210), [], 'the end was used up');
  w.observe([{ ...idle, status: 'working' }], [], 300);
  assert.deepEqual(w.observe([{ ...idle, lastMessage: done }], [], 400).map((d) => d.ids), [['a']], 'the next end sends it');
  for (const patch of [
    { question: { toolUseId: 'q', title: 'Which?', details: '', options: [], category: 'c', askedAt: 1 } },
    { round: { key: 'r1', source: 'tool' as const, title: 'Round', intro: '', at: 1, questions: [] } },
    { menu: { toolUseId: 'm1', at: 1, questions: [] } },
  ]) {
    const asked = ended(patch);
    assert.deepEqual(asked.w.observe([asked.idle], [], 200), [], Object.keys(patch)[0]);
  }
});

test('a reply ends on a question when its last paragraph ends on a question mark, past closing marks and space', () => {
  for (const text of [
    'Shall I go on?',
    'Here is the plan.\n\nShould I start with the cart?  \n',
    '**Merge them or keep them apart?**',
    'Which one: _the first?_',
    'Ready to run `pnpm build`?`',
    'He asked: "is it done?"',
    'Next step (want me to commit?)',
    'Shall I push?\n\n',
  ]) assert.equal(endsOnQuestion(text), true, text);
  for (const text of [
    'Done.',
    'Is the cart right? I checked it: yes.',
    'Should I start?\n\nNo need: I started.',
    'See https://example.com/a?b',
    '',
  ]) assert.equal(endsOnQuestion(text), false, text);
  assert.equal(endsOnQuestion(null), false);
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

const DESIGN = '.pitwall/artifacts/invoice-export/04-design-discussion-invoice-export.md';
const stream = { kind: 'document' as const, path: DESIGN, heading: 'Stream or build the file first?', quote: 'Streaming starts the download at once;\nbuilding first can report a row count.' };
const units = { kind: 'document' as const, path: DESIGN, heading: 'Resolved Design Questions', quote: 'Amounts are written in major units with two decimals' };

test('a comment on a document keeps its path, heading and passage; sent on its own it reads as prose about them, without a command', () => {
  const [kept] = addParked([], { text: 'Say what a failed stream leaves behind.', ref: stream }, 50);
  assert.deepEqual(kept.ref, stream);
  assert.equal(draftMessage(kept), `About \`${DESIGN}\`, under “Stream or build the file first?”:\n> Streaming starts the download at once;\n> building first can report a row count.\n\nSay what a failed stream leaves behind.`);
  assert.equal(draftMessage({ text: 'Shorter.', ref: { ...stream, heading: null, quote: 'Intro\n\nMore' } }), `About \`${DESIGN}\`:\n> Intro\n>\n> More\n\nShorter.`);
  const { w, idle } = ended({}, [{ ...kept, auto: true, armedAt: 100 }]);
  assert.equal(w.observe([idle], [], 200)[0]?.text, draftMessage(kept), 'armed, it goes alone the same way');
});

test("a document's comments go as one rpi command: update and the path on its first line, then each comment's heading, passage and text", () => {
  const drafts = [{ text: 'Say what a failed stream leaves behind.', ref: stream }, { text: 'Keep minor units in the file too.', ref: units }, { text: 'Not a comment.' }];
  assert.equal(documentCommentsMessage('/rpi:rpi', DESIGN, drafts), [
    `/rpi:rpi update ${DESIGN}`,
    'Under “Stream or build the file first?”:\n> Streaming starts the download at once;\n> building first can report a row count.\n\nSay what a failed stream leaves behind.',
    'Under “Resolved Design Questions”:\n> Amounts are written in major units with two decimals\n\nKeep minor units in the file too.',
  ].join('\n\n'));
  assert.equal(documentCommentsMessage('/rpi', DESIGN, [{ text: 'Why?', ref: { ...units, heading: null } }]), `/rpi update ${DESIGN}\n\n> Amounts are written in major units with two decimals\n\nWhy?`);
});

test('a passage is kept trimmed, its blank lines at most one, and cut with an ellipsis at 600 characters', () => {
  assert.equal(cutQuote('  Streaming starts  \n\n\n\nat once.\n'), 'Streaming starts\n\nat once.');
  const long = cutQuote('word '.repeat(200));
  assert.equal(long.length, MAX_QUOTE);
  assert.ok(long.endsWith('word…'));
});

test('a stored draft about lines from before document comments still parses and reads as before; a document ref is checked too', () => {
  const park = actionBodies.park;
  const old = { text: 'Round it.', ref: { path: 'a.ts', side: 'new', start: 3, end: 3, lines: ['let a = 1;'] } };
  assert.deepEqual(park.parse(old), old);
  assert.equal(draftMessage(old as Parked), 'About `a.ts` line 3:\n```\nlet a = 1;\n```\n\nRound it.');
  assert.deepEqual(park.parse({ text: 'x', ref: stream }).ref, stream);
  assert.equal(park.safeParse({ text: 'x', ref: { ...stream, quote: 'q'.repeat(MAX_QUOTE + 1) } }).success, false);
  assert.equal(park.safeParse({ text: 'x', ref: { ...stream, quote: '' } }).success, false);
  assert.equal(park.safeParse({ text: 'x', ref: { kind: 'document', path: DESIGN, quote: 'q' } }).success, false, 'the heading is named, null when there is none');
});

test('a comment carries the version it was written on; only one on a version older than the latest says so, and one without a version reads as before', () => {
  const onTwo = { ...stream, version: 2 };
  assert.deepEqual(actionBodies.park.parse({ text: 'x', ref: onTwo }).ref, onTwo);
  assert.equal(actionBodies.park.safeParse({ text: 'x', ref: { ...stream, version: 0 } }).success, false);
  const moved = 'written on version 2; the document is at version 3 now, so the passage may have moved';
  assert.equal(draftMessage({ text: 'Why?', ref: onTwo }, 3), `About \`${DESIGN}\`, under “Stream or build the file first?” (${moved}):\n> Streaming starts the download at once;\n> building first can report a row count.\n\nWhy?`);
  assert.equal(draftMessage({ text: 'Why?', ref: onTwo }, 2), draftMessage({ text: 'Why?', ref: stream }), 'on the latest, as before');
  assert.equal(draftMessage({ text: 'Why?', ref: stream }, 3), draftMessage({ text: 'Why?', ref: stream }), 'an unknown version, as before');
  assert.equal(draftMessage({ text: 'Why?', ref: onTwo }, null), draftMessage({ text: 'Why?', ref: stream }), 'a document the board has not read');
  assert.deepEqual(documentCommentsMessage('/rpi', DESIGN, [{ text: 'Why?', ref: onTwo }, { text: 'And?', ref: { ...units, heading: null, version: 1 } }, { text: 'Now.', ref: { ...units, version: 3 } }], 3).split('\n\n'), [
    `/rpi update ${DESIGN}`,
    `Under “Stream or build the file first?” (${moved}):\n> Streaming starts the download at once;\n> building first can report a row count.`, 'Why?',
    'Written on version 1; the document is at version 3 now, so the passage may have moved:\n> Amounts are written in major units with two decimals', 'And?',
    'Under “Resolved Design Questions”:\n> Amounts are written in major units with two decimals', 'Now.',
  ]);
  const parked: Parked[] = [{ id: 'c', text: 'Why?', auto: true, armedAt: 150, at: 0, ref: onTwo }];
  const w = turnEnds((task, path) => (task === 's' && path === DESIGN ? 3 : null));
  w.observe([session({ parked })], [], 100);
  assert.equal(w.observe([session({ status: 'idle', parked, lastMessage: done })], [], 200)[0]?.text, draftMessage({ text: 'Why?', ref: onTwo }, 3), 'armed, it says so too');
});
