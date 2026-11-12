import assert from 'node:assert/strict';
import { until } from '../cdp.ts';
import { logged, lowContrast, openQueue, openSheetOf, POSTED_MS, ready, sidewaysScroll, stateOf, still, tiles, type Check } from '../helpers.ts';

// The round as `scope` shows it: its questions, how many it counts as answered, which ones, and its send button.
const roundIn = (scope: string) => {
  const root = document.querySelector(scope);
  const send = root?.querySelector<HTMLButtonElement>('[data-primary], [data-round-send]');
  return {
    questions: [...(root?.querySelectorAll<HTMLElement>('[data-question]') ?? [])].map((q) => q.dataset.question),
    progress: root?.querySelector('[data-round-progress]')?.textContent ?? null,
    answered: [...(root?.querySelectorAll<HTMLElement>('[data-question][data-answered]') ?? [])].map((q) => q.dataset.question),
    send: send ? { label: (send.querySelector('span') ?? send).textContent, disabled: send.disabled } : null,
  };
};

const ownAnswer = (scope: string, id: string) => document.querySelector<HTMLTextAreaElement>(`${scope} [data-question="${id}"] textarea[aria-label="Your answer to ${id}"]`)?.value ?? null;

const QUESTIONS = ['Q1', 'Q2', 'Q3', 'Q4'];
const CARD = '[data-card]';
const SHEET = '#task-sheet';

export const rounds: Check[] = [
  {
    name: "QR1 a round of questions is one card with every question answered next to it: an option, Claude's recommendation or an own answer; Discuss talks one question through with a copy of the conversation, under that question, and Use as my answer takes what it said; the answers outlive a reload; the main button counts them and sends them as one message after its 5 s Undo, the question left out stays open, and the discussion goes with the round",
    scenario: 'round',
    clock: 'fast',
    async run({ page, mock, shot, themes }) {
      await openQueue(page, mock, 's-events');
      await ready(page, 's-events');
      assert.equal(await page.eval(() => document.querySelector<HTMLElement>('[data-card]')!.dataset.kind), 'round');
      assert.deepEqual(await page.eval(roundIn, CARD), { questions: QUESTIONS, progress: '0 of 4 answered', answered: [], send: { label: 'Answer a question', disabled: true } });
      await shot('round');

      await page.click(`${CARD} [data-question="Q1"] [data-round-option]`, 'Only me');
      await page.click(`${CARD} [data-question="Q2"] [data-recommends] button`, 'Take it');
      await page.until('two answered', () => document.querySelector('[data-card] [data-round-progress]')?.textContent === '2 of 4 answered');
      assert.equal(await page.eval(() => document.querySelector('[data-card] [data-question="Q1"] [data-round-option][aria-pressed="true"]')?.textContent), 'Only meNo accounts, no onboarding, no moderationRecommended');
      assert.equal(await page.eval(() => document.querySelector('[data-card] [data-question="Q2"] [data-recommends]')?.hasAttribute('data-taken')), true);

      await page.click(`${CARD} [data-question="Q3"] [data-discuss]`);
      await page.until('the discussion field, focused', () => document.activeElement?.matches('[data-card] [data-question="Q3"] textarea[aria-label="What to discuss about Q3"]'));
      await page.type('Does cinema belong?');
      await page.key('Enter');
      await page.until('the copy reading, under Q3', () => document.querySelector('[data-card] [data-question="Q3"] [data-aside][data-state="thinking"]')?.textContent?.includes('Read: src/invoice/LineItem.ts'));
      await page.until('its answer', () => !!document.querySelector('[data-card] [data-question="Q3"] [data-aside][data-state="done"] strong'));
      const discussed = await stateOf(mock, 's-events');
      assert.deepEqual(discussed.asides.map((a: { about: unknown; turns: { question: string }[] }) => [a.about, a.turns.map((t) => t.question)]),
        [[{ round: 'toolu_01Round', question: 'Q3' }, ['Does cinema belong?']]]);
      assert.equal(discussed.answered, null, "nothing reached the task's Claude");
      await shot('round-discussed');

      await page.click(`${CARD} [data-question="Q3"] [data-aside] button`, 'Use as my answer');
      await page.until('the answer in Q3', ownAnswer, CARD, 'Q3');
      const said = (await page.eval(ownAnswer, CARD, 'Q3'))!;
      assert.match(said, /^On the side: \*\*Does cinema belong\?\*\*/);
      const answered = { questions: QUESTIONS, progress: '3 of 4 answered', answered: ['Q1', 'Q2', 'Q3'], send: { label: 'Send 3 of 4 answers', disabled: false } };
      assert.deepEqual(await page.eval(roundIn, CARD), answered);
      await page.until('the page to settle', still);
      await themes(async (scheme) => assert.deepEqual(await page.eval(lowContrast, 4.5), [], `every text of the round reads at 4.5:1 (${scheme})`));

      await page.goto(`${mock.url}/`);
      await ready(page, 's-events');
      assert.deepEqual(await page.eval(roundIn, CARD), answered, 'the answers are there after a reload');
      assert.equal(await page.eval(ownAnswer, CARD, 'Q3'), said);

      await page.click(`${CARD} [data-primary]`);
      await page.until('the hold toast', () => [...document.querySelectorAll('[data-toast]')].some((t) => t.textContent?.includes('Answers to 3 of 4 questions')));
      const [posted] = await logged(mock, 'the answers', (e) => e.action === 'answer-round' && e.sessionId === 's-events', POSTED_MS);
      assert.deepEqual(posted.body, {
        round: 'toolu_01Round',
        replies: {
          Q1: { option: 'Only me', recommended: false, text: '' },
          Q2: { option: null, recommended: true, text: '' },
          Q3: { option: null, recommended: false, text: said },
        },
      });
      const after = await until('the round closed and its discussion gone', async () => {
        const s = await stateOf(mock, 's-events');
        return s.round === null && s.asides.length === 0 ? s : null;
      });
      assert.deepEqual([after.answered.key, after.answered.text, after.dismissedRound], ['r:toolu_01Round', 'Answers to 3 of 4 questions', 'toolu_01Round']);
    },
  },
  {
    name: "QR2 on its task's page a round is answered the same way: Take every recommendation answers each question that has one, an own answer the last, and Send posts them all; the Wall tile names the round, and Dismiss clears it without an answer",
    scenario: 'round',
    clock: 'fast',
    async run({ page, mock, shot, themes }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      assert.match(await page.eval(() => document.querySelector('[data-tile][data-session="s-events"]')!.textContent ?? ''), /Round 1: who it is for and what it shows/);

      await openSheetOf(page, mock, 's-events');
      await page.until('the round on the page', () => !!document.querySelector('#task-sheet [data-queued] [data-round]'));
      assert.deepEqual(await page.eval(roundIn, SHEET), { questions: QUESTIONS, progress: '0 of 4 answered', answered: [], send: { label: 'Answer a question', disabled: true } });
      await page.click(`${SHEET} [data-round] button`, 'Take every recommendation');
      await page.until('three answered', () => document.querySelector('#task-sheet [data-round-progress]')?.textContent === '3 of 4 answered');
      assert.equal(await page.eval(() => !!document.querySelector('#task-sheet [data-round] button')?.textContent?.startsWith('Take')), false, 'nothing is left to take');
      await page.click(`${SHEET} [data-question="Q4"] textarea[aria-label="Your answer to Q4"]`);
      await page.type('The city calendar and two club pages');
      await page.until('all answered', () => document.querySelector('#task-sheet [data-round-send]')?.textContent === 'Send all 4 answers');
      await shot('round-page');
      await themes(async (scheme) => assert.deepEqual(await page.eval(lowContrast, 4.5), [], `every text of the round reads at 4.5:1 (${scheme})`));
      await page.click(`${SHEET} [data-round-send]`);
      const [posted] = await logged(mock, 'the answers', (e) => e.action === 'answer-round' && e.sessionId === 's-events', POSTED_MS);
      assert.deepEqual(posted.body.replies, {
        Q1: { option: 'Only me', recommended: false, text: '' },
        Q2: { option: null, recommended: true, text: '' },
        Q3: { option: null, recommended: true, text: '' },
        Q4: { option: null, recommended: false, text: 'The city calendar and two club pages' },
      });
      await until('the round closed', async () => (await stateOf(mock, 's-events')).round === null);

      await mock.reset('round');
      await openSheetOf(page, mock, 's-events');
      await page.until('the round again', () => !!document.querySelector('#task-sheet [data-queued] [data-round]'));
      await page.click(`${SHEET} [data-queued] button`, 'Dismiss');
      const [dismissed] = await logged(mock, 'the dismissal', (e) => e.action === 'dismiss' && e.sessionId === 's-events', POSTED_MS);
      assert.deepEqual(dismissed.body, { key: 'r:toolu_01Round' });
      const after = await until('the round put aside', async () => {
        const s = await stateOf(mock, 's-events');
        return s.round === null ? s : null;
      });
      assert.deepEqual([after.dismissedRound, after.status], ['toolu_01Round', 'idle'], 'Claude got nothing');
    },
  },
  {
    name: 'QR3 narrow: a round fits a phone-wide window on its card and on its task page, a picked option and a discussion included, with nothing scrolling sideways and the send button in reach',
    scenario: 'round',
    narrow: true,
    async run({ page, mock, shot }) {
      await openQueue(page, mock, 's-events');
      await ready(page, 's-events');
      await page.click(`${CARD} [data-question="Q1"] [data-round-option]`, 'Only me');
      await page.click(`${CARD} [data-question="Q1"] [data-discuss]`);
      await page.type('Why not friends?');
      await page.key('Enter');
      await page.until('its answer', () => !!document.querySelector('[data-card] [data-question="Q1"] [data-aside][data-state="done"] strong'));
      assert.deepEqual(await page.eval(sidewaysScroll), [], 'the card');
      const send = await page.eval(() => {
        const r = document.querySelector('[data-card] [data-primary]')!.getBoundingClientRect();
        return { text: document.querySelector('[data-card] [data-primary] span')!.textContent, inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth };
      });
      assert.deepEqual(send, { text: 'Send 1 of 4 answers', inView: true });
      await shot('round-narrow');

      await openSheetOf(page, mock, 's-events');
      await page.until('the round on the page', () => !!document.querySelector('#task-sheet [data-queued] [data-round]'));
      assert.deepEqual(await page.eval(sidewaysScroll), [], 'the task page');
    },
  },
];
