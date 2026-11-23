import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentCommentsMessage, MAX_QUOTE } from './codeRef.ts';
import { actionBodies } from './contract.ts';
import type { Review } from './db.ts';
import { addComment, editComment, EMPTY_REVIEW, keepPhase, markOutdated, markSent, MAX_COMMENTS, pruneReview, removeComments } from './review.ts';
import { BOARD_HANDOFF, type OutdatedMark, type Workflow } from './rpi.ts';

const DESIGN = '.pitwall/artifacts/invoice-export/04-design-discussion-invoice-export.md';
const stream = { path: DESIGN, version: 3, heading: 'Stream or build the file first?', quote: 'Streaming starts the download at once;\nbuilding first can report a row count.' };
const units = { path: DESIGN, version: 3, heading: 'Resolved Design Questions', quote: 'Amounts are written in major units with two decimals' };
const whole = { path: DESIGN, version: 3, heading: null, quote: null };

test('a comment keeps its document, version, passage and heading, or none for the whole document; it is open until sent, and in the order written', () => {
  const one = addComment(EMPTY_REVIEW, { ...stream, text: '  Say what a failed stream leaves behind. ' }, 50);
  const [c] = one.comments;
  assert.deepEqual({ ...c, id: '' }, { id: '', ...stream, text: 'Say what a failed stream leaves behind.', at: 50, sentAt: null });
  const both = addComment(one, { ...whole, heading: 'ignored', text: 'Shorter overall.' }, 60);
  assert.deepEqual(both.comments.map((x) => [x.quote, x.heading, x.text]), [[stream.quote, stream.heading, c.text], [null, null, 'Shorter overall.']], 'no heading without a passage');
  const back = addComment(both, { ...units, text: 'Put back by Undo.', at: 55, sentAt: 58 }, 99);
  assert.deepEqual(back.comments.map((x) => [x.text, x.at, x.sentAt]), [[c.text, 50, null], ['Put back by Undo.', 55, 58], ['Shorter overall.', 60, null]], 'an Undo puts it back where it was');
  assert.throws(() => addComment(EMPTY_REVIEW, { ...whole, text: '  ' }), /the comment is empty/);
  assert.throws(() => addComment(EMPTY_REVIEW, { ...whole, text: 'x'.repeat(20_001) }), /too long/);
});

test('an open comment can be edited and deleted; a sent one only deleted; sending marks only the open ones named', () => {
  let r = addComment(addComment(EMPTY_REVIEW, { ...stream, text: 'One' }, 1), { ...whole, text: 'Two' }, 2);
  const [one, two] = r.comments.map((c) => c.id);
  r = editComment(r, { comment: one, text: ' Uno ' });
  assert.equal(r.comments[0].text, 'Uno');
  assert.throws(() => editComment(r, { comment: 'gone', text: 'x' }), /this comment is gone/);
  r = markSent(r, [one], 10);
  assert.deepEqual(r.comments.map((c) => c.sentAt), [10, null]);
  assert.equal(markSent(r, [one, two], 20).comments[0].sentAt, 10, 'sent once');
  assert.throws(() => editComment(r, { comment: one, text: 'x' }), /sent already/);
  assert.deepEqual(removeComments(r, [one]).comments.map((c) => c.id), [two]);
});

test(`a task holds ${MAX_COMMENTS} comments: a new one forgets the oldest sent one, and with none sent is refused`, () => {
  let r: Review = EMPTY_REVIEW;
  for (let i = 0; i < MAX_COMMENTS; i++) r = addComment(r, { ...whole, text: `c${i}` }, i);
  assert.throws(() => addComment(r, { ...whole, text: 'more' }), /at most 200 comments/);
  r = markSent(markSent(r, [r.comments[5].id], 1000), [r.comments[3].id], 2000);
  const next = addComment(r, { ...whole, text: 'more' }, 3000);
  assert.equal(next.comments.length, MAX_COMMENTS);
  assert.ok(!next.comments.some((c) => c.text === 'c5'), 'the one sent first goes');
  assert.ok(next.comments.some((c) => c.text === 'c3'));
});

test("a document's comments go as one rpi command: update and the path on its first line, then each passage's heading, the passage and the text, and each on the whole document as itself", () => {
  const comments = [{ ...stream, text: 'Say what a failed stream leaves behind.' }, { ...whole, text: 'Shorter overall.' }, { ...units, heading: null, text: 'Why?' }];
  assert.equal(documentCommentsMessage('/rpi:rpi', DESIGN, comments, 3), [
    `/rpi:rpi update ${DESIGN}`,
    'Under “Stream or build the file first?”:\n> Streaming starts the download at once;\n> building first can report a row count.\n\nSay what a failed stream leaves behind.',
    'About the whole document:\nShorter overall.',
    '> Amounts are written in major units with two decimals\n\nWhy?',
    BOARD_HANDOFF,
  ].join('\n\n'));
});

test('only a passage comment written on a version older than the latest says so, as its passage may have moved', () => {
  const moved = 'written on version 2; the document is at version 3 now, so the passage may have moved';
  assert.deepEqual(documentCommentsMessage('/rpi', DESIGN, [
    { ...stream, version: 2, text: 'Why?' }, { ...units, heading: null, version: 1, text: 'And?' }, { ...units, text: 'Now.' }, { ...whole, version: 1, text: 'All of it.' }, { ...units, version: null, text: 'Before versions.' },
  ], 3).split('\n\n'), [
    `/rpi update ${DESIGN}`,
    `Under “Stream or build the file first?” (${moved}):\n> Streaming starts the download at once;\n> building first can report a row count.`, 'Why?',
    'Written on version 1; the document is at version 3 now, so the passage may have moved:\n> Amounts are written in major units with two decimals', 'And?',
    'Under “Resolved Design Questions”:\n> Amounts are written in major units with two decimals', 'Now.',
    'About the whole document:\nAll of it.',
    'Under “Resolved Design Questions”:\n> Amounts are written in major units with two decimals', 'Before versions.',
    BOARD_HANDOFF,
  ]);
  assert.equal(documentCommentsMessage('/rpi', DESIGN, [{ ...stream, version: 2, text: 'Why?' }], null), documentCommentsMessage('/rpi', DESIGN, [{ ...stream, text: 'Why?' }]), 'a document the board has not read');
});

test('the comment actions check what they are given', () => {
  const add = actionBodies['add-comment'];
  assert.deepEqual(add.parse({ ...stream, text: 'x' }), { ...stream, text: 'x' });
  assert.deepEqual(add.parse({ ...whole, version: null, text: 'x' }), { ...whole, version: null, text: 'x' });
  assert.equal(add.safeParse({ ...stream, quote: 'q'.repeat(MAX_QUOTE + 1), text: 'x' }).success, false);
  assert.equal(add.safeParse({ ...stream, quote: '', text: 'x' }).success, false, 'a passage is never empty; the whole document is null');
  assert.equal(add.safeParse({ path: DESIGN, version: 3, quote: 'q', text: 'x' }).success, false, 'the heading is named, null when there is none');
  assert.equal(add.safeParse({ ...stream, version: 0, text: 'x' }).success, false);
  assert.equal(add.safeParse({ ...stream, path: '', text: 'x' }).success, false);
  assert.equal(actionBodies['keep-outdated'].safeParse({ phase: 'review' }).success, false);
  assert.deepEqual(actionBodies.answer.parse({ key: null, text: '/rpi x', comments: ['a'], rework: 'implement', fresh: true }), { key: null, text: '/rpi x', comments: ['a'], rework: 'implement', fresh: true });
  assert.equal(actionBodies.answer.safeParse({ key: null, text: 'x', rework: 'review' }).success, false);
});

const mark = (patch: Partial<OutdatedMark> = {}): OutdatedMark => ({ document: 'o.md', version: 2, because: 'r.md', at: 1, earlier: {}, ...patch });

test('marks are added over the ones there, one is kept as is by hand, and a review the workflow has moved past none of stays the same object', () => {
  assert.throws(() => markOutdated(EMPTY_REVIEW, {}), /no later phase/);
  const r = markOutdated(markOutdated(EMPTY_REVIEW, { outline: mark(), implement: mark({ document: null, version: null }) }), { outline: mark({ because: 'd.md' }) });
  assert.deepEqual(Object.keys(r.outdated), ['outline', 'implement']);
  assert.equal(r.outdated.outline!.because, 'd.md');
  assert.deepEqual(Object.keys(keepPhase(r, 'outline').outdated), ['implement']);
  const w: Workflow = {
    folder: 'f', flow: null, current: 'implement', outline: null, documents: 1, folders: 1, stamp: 's', versions: { 'o.md': { latest: 2, settled: true } },
    steps: [{ phase: 'outline', state: 'done', document: 'o.md' }, { phase: 'implement', state: 'current', document: 'o.md' }],
  };
  assert.equal(pruneReview(r, w), r);
  assert.equal(pruneReview(r, null), r, 'not before the documents are read');
  assert.deepEqual(Object.keys(pruneReview(r, { ...w, versions: { 'o.md': { latest: 3, settled: true } } }).outdated), ['implement']);
});
