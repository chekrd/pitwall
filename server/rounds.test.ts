import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answeredCount, proseRound, recommendedAnswer, roundAnswerLabel, roundReply, roundTitle, type Round } from './rounds.ts';

// As the stock grill-me skill wrote its first round in a real session.
const PROSE = `The repo is empty, so every decision is open. Here is round 1.

❓ **Q1** - **Audience and purpose**: Is this a tool only for you, or a product for strangers? And is the point the tool itself?

➡️ Single-user personal tool, built for the result. That removes accounts and onboarding.

---

❓ **Q2** - **Where you use it**: When you check what's on, where are you?
- (a) a web app on your phone
- (b) a web app on your desktop
- (c) a pushed digest (email or Telegram) with no app to open

➡️ (a), a mobile-first web app installable to the home screen. A weekly digest can be added later.

---

❓ **Q5** - **What like/dislike means and what "propose on top" looks like**:
- What do you rate: individual events only, or also the things behind them?
- Is dislike "less of this kind" or just "hide this one"?

➡️ Rate individual events, and let the app infer the rest.

---

❓ **Q6** - **The main moment of use**: Which matters more?
- (a) "What's on tonight or this weekend?", browsing close to the date.
- (b) "Don't let me miss it", being told weeks ahead.

➡️ Both, but design for (b) first. It is the one that a plain listing site doesn't give you.

It also means the app has to notice newly announced events.`;

test('a round written in the grill-me format reads as its questions, each with its recommendation; lettered items are its options', () => {
  const round = proseRound(PROSE)!;
  assert.equal(round.intro, 'The repo is empty, so every decision is open. Here is round 1.');
  assert.deepEqual(round.questions.map((q) => [q.id, q.title, q.options.length, q.recommended]), [
    ['Q1', 'Audience and purpose', 0, null],
    ['Q2', 'Where you use it', 3, '(a) a web app on your phone'],
    ['Q5', 'What like/dislike means and what "propose on top" looks like', 0, null],
    ['Q6', 'The main moment of use', 2, null],
  ]);
  const [q1, q2, q5, q6] = round.questions;
  assert.equal(q1.body, 'Is this a tool only for you, or a product for strangers? And is the point the tool itself?');
  assert.equal(q1.recommendation, 'Single-user personal tool, built for the result. That removes accounts and onboarding.');
  assert.equal(q2.body, "When you check what's on, where are you?", 'the options leave the body');
  assert.deepEqual(q2.options.map((o) => o.label), ['(a) a web app on your phone', '(b) a web app on your desktop', '(c) a pushed digest (email or Telegram) with no app to open']);
  assert.match(q5.body, /^- What do you rate[^]*hide this one"\?$/, 'a plain list stays in the body');
  assert.equal(q6.recommendation, "Both, but design for (b) first. It is the one that a plain listing site doesn't give you.\n\nIt also means the app has to notice newly announced events.");
});

test('text without a question in that format, or with a number twice, is no round', () => {
  assert.equal(proseRound('Which one do you want? ❓'), null);
  assert.equal(proseRound('Done. Nothing to ask.'), null);
  assert.equal(proseRound('❓ **Q1** - **A**: x\n\n---\n\n❓ **Q1** - **B**: y'), null);
});

const round: Round = {
  key: 'k', source: 'tool', title: '', intro: '', at: 0,
  questions: [
    { id: 'Q1', title: 'Audience', body: 'Who?', options: [{ label: 'Only me' }, { label: 'Friends' }], recommendation: 'Only you.', recommended: 'Only me' },
    { id: 'Q2', title: 'Where', body: 'Where?', options: [{ label: 'Phone' }], recommendation: 'Phone first, desk too.', recommended: null },
    { id: 'Q3', title: 'Sources', body: 'Which?', options: [], recommendation: '', recommended: null },
  ],
};

test('the answers go to Claude as one message that names each question, and a question left out is said to stay open', () => {
  const answers = {
    Q1: { option: 'Friends', recommended: false, text: ' three of us ' },
    Q2: { option: null, recommended: true, text: '' },
    Q3: { option: null, recommended: false, text: '  ' },
  };
  assert.equal(roundReply(round, answers), [
    'My answers to your questions:',
    'Q1 — Audience: Friends — three of us',
    'Q2 — Where: Your recommendation',
    'Q3 — Sources: not answered yet; keep it open',
  ].join('\n\n'));
  assert.equal(answeredCount(round, answers), 2);
  assert.equal(roundAnswerLabel(round, answers), 'Answers to 2 of 3 questions');
  assert.equal(roundAnswerLabel(round, { ...answers, Q3: { option: null, recommended: false, text: 'the city calendar' } }), 'Answers to all 3 questions');
});

test('answers that fit no question of the round are refused, and so is a round with nothing answered', () => {
  const own = { option: null, recommended: false, text: 'x' };
  assert.throws(() => roundReply(round, {}), /answer at least one question/);
  assert.throws(() => roundReply(round, { Q9: own }), /no question Q9/);
  assert.throws(() => roundReply(round, { Q1: { ...own, option: 'Strangers' } }), /unknown option for Q1/);
  assert.throws(() => roundReply(round, { Q3: { option: null, recommended: true, text: '' } }), /Q3 has no recommendation/);
});

test("Claude's recommendation as an answer is its option, or the recommendation itself when it is none of them", () => {
  assert.deepEqual(round.questions.map((q) => recommendedAnswer(q)), [
    { option: 'Only me', recommended: false, text: '' }, { option: null, recommended: true, text: '' }, null,
  ]);
});

test('a round is named by its title, else by its questions', () => {
  assert.equal(roundTitle({ ...round, title: 'Round 2' }), 'Round 2');
  assert.equal(roundTitle(round), '3 questions: Audience · Where · Sources');
  assert.equal(roundTitle({ ...round, questions: round.questions.slice(0, 1) }), 'Audience');
});
