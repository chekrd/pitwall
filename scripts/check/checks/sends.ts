import assert from 'node:assert/strict';
import { sleep, until } from '../cdp.ts';
import { actions, card, dealt, frontIs, HELD_MS, logged, openQueue, pastePng, pillAt, POSTED_MS, pressEnter, ready, replyIn, sent, stateOf, still, toastsOf, unguarded, watchDeals, type Check } from '../helpers.ts';

export const sends: Check[] = [
  {
    name: 'P5.2.1 ⏎ on s-cart deals it down and s-hooks comes up; the toast says Sending: “Merge both carts” on one line of a set width, counts down and offers Undo Esc; the meter counts 2 decisions; 5 s on, one accept-advice goes out with the second opinion it showed',
    async run({ page, mock, shot }) {
      const { advice } = await stateOf(mock, 's-cart');
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.eval(watchDeals);
      await page.key('Enter');
      const pressed = Date.now();
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.deepEqual(await page.eval(dealt), ['down']);
      const [held] = await page.until('the undo toast', toastsOf, 'undo');
      assert.match(held.text, /^Sending: “Merge both carts”\s*· [1-5] s\s+Undo\s+Esc$/);
      const count = () => Number(document.querySelector('[data-toast][data-kind="undo"]')?.textContent?.match(/· (\d) s/)?.[1]);
      const first = await page.eval(count);
      // The countdown follows the shared clock, which ticks once a second at its own phase.
      await until('the countdown to count down', async () => (await page.eval(count)) < first, 2100);
      assert.deepEqual(await page.eval(() => [document.querySelector('[data-meter] [role="group"]')?.getAttribute('aria-label'), document.title]), [
        '2 decisions · 1 terminal prompt · 2 finished turns', 'Pitwall',
      ]);
      await shot('queue-held');
      await sleep(HELD_MS - (Date.now() - pressed));
      const sent = await actions(mock);
      assert.deepEqual(sent.map((e) => [e.action, e.sessionId, e.body, e.status]), [['accept-advice', 's-cart', { key: 'q:toolu_01Cart', adviceAt: advice.at }, 204]]);
      assert.ok(sent[0].at - pressed >= 4900, `posted ${sent[0].at - pressed} ms after ⏎`);
    },
  },
  {
    name: 'P5.2.2 Undo gives back what the send took: option 2 with a note and a pasted picture held, Z within 3 s brings s-cart back with both in the reply box and nothing goes out; sent again, the answer carries the choice, the note and the picture',
    clock: 'fast',
    async run({ wait, page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('only if stock allows');
      await page.eval(pastePng, '[data-card] textarea');
      await page.until('the picture uploaded', () => !!document.querySelector('[data-card] [data-state="ready"]'));
      await page.click('[data-card] [data-option="2"]');
      const pressed = Date.now();
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.deepEqual(await page.eval(replyIn, '[data-card]'), null, 'the reply box went with s-cart');
      await page.key('z');
      await page.until('s-cart back at the front', frontIs, 's-cart');
      assert.ok(Date.now() - pressed < 3000, `back ${Date.now() - pressed} ms after the press`);
      assert.deepEqual({ ...(await page.eval(replyIn, '[data-card]')), focused: undefined }, { value: 'only if stock allows', files: ['ready shot.png'], focused: undefined });
      assert.equal(await page.eval(() => document.querySelector('[data-toast][data-kind="undo"]')), null, 'the undo toast stayed');
      await wait(6000);
      assert.deepEqual(await actions(mock), []);

      await page.until('the guard to end', unguarded);
      await page.click('[data-card] [data-option="2"]');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      const [answer] = await logged(mock, 'the answer', (e) => e.action === 'answer', POSTED_MS);
      const [upload] = await logged(mock, 'the upload', (e) => e.path === '/api/uploads');
      assert.deepEqual([answer.sessionId, answer.status, { ...answer.body, files: undefined }], ['s-cart', 204, {
        key: 'q:toolu_01Cart', choice: 'Keep the account cart', text: 'only if stock allows', files: undefined,
      }]);
      assert.equal(upload.body.filename, 'shot.png');
      assert.equal(answer.body.files.length, 1);
      assert.match(answer.body.files[0], /\/uploads\/[\w-]+\/shot\.png$/);
    },
  },
  {
    name: 'P5.2.3 the choice frozen while the second opinion runs stays: with Send “Merge both carts” shown, advice that finishes on Ask the shopper shows on option 3, option 1 keeps the highlight, and ⏎ answers Merge both carts, not the advice',
    clock: 'fast',
    scenario: 'freeze',
    async run({ wait, page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      assert.equal((await page.eval(card))!.primary, 'Send “Merge both carts”');
      await mock.post('/mock/advice', { id: 's-cart', state: 'done', choice: 'Ask the shopper', confidence: 71 });
      const third = await page.until('the late second opinion on option 3', () => {
        const option = document.querySelector('[data-card] [data-option="3"]')?.parentElement;
        return option?.innerText.includes("Second opinion's pick · 71%") && option.innerText;
      });
      assert.match(third, /Ask the shopper, because it fits what the task asks for\./);
      const frozen = await page.eval(() => [...document.querySelectorAll('[data-card] [data-frozen] [data-option]')].map((o) => (o as HTMLElement).dataset.option));
      assert.deepEqual([frozen, (await page.eval(card))!.primary], [['1'], 'Send “Merge both carts”']);
      await shot('queue-freeze');
      await page.until('the guard to end', unguarded);
      await page.key('Enter');
      await wait(HELD_MS);
      await logged(mock, 'the send', sent, POSTED_MS);
      assert.deepEqual((await actions(mock)).map((e) => [e.action, e.body]), [['answer', { key: 'q:toolu_01Cart', choice: 'Merge both carts' }]]);
    },
  },
  {
    name: 'P5.2.4 a second opinion that came in after the freeze is accepted by its own digit: 3 sends accept-advice with the new advice\'s at',
    clock: 'fast',
    scenario: 'freeze',
    async run({ wait, page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      const advice = await mock.post('/mock/advice', { id: 's-cart', state: 'done', choice: 'Ask the shopper', confidence: 71 });
      await page.until('the late second opinion on option 3', () => !!document.querySelector('[data-card] [data-option="3"]')?.parentElement?.innerText.includes("Second opinion's pick · 71%"));
      await page.until('the guard to end', unguarded);
      await page.key('3');
      await wait(HELD_MS);
      await logged(mock, 'the send', sent, POSTED_MS);
      assert.deepEqual((await actions(mock)).map((e) => [e.action, e.body]), [['accept-advice', { key: 'q:toolu_01Cart', adviceAt: advice.at }]]);
    },
  },
  {
    name: 'P5.2.5 advice that changes after the freeze relabels the primary to Send “Merge both carts”, guarded about 0.9 s, and ⏎ answers with that choice instead of accepting',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      assert.equal((await page.eval(card))!.primary, 'Accept suggestion');
      await mock.post('/mock/advice', { id: 's-cart', state: 'done', choice: 'Merge both carts' });
      const changed = Date.now();
      await page.until('the relabel, guarded', () => {
        const c = document.querySelector<HTMLElement>('[data-card] [data-primary]');
        return c?.firstElementChild?.textContent === 'Send “Merge both carts”' && c.hasAttribute('data-guarded');
      });
      await page.until('the guard to end', unguarded);
      const held = Date.now() - changed;
      assert.ok(held > 700 && held < 1600, `the guard ended ${held} ms after the advice changed`);
      await page.key('Enter');
      await sleep(HELD_MS);
      await logged(mock, 'the send', sent, POSTED_MS);
      assert.deepEqual((await actions(mock)).map((e) => [e.action, e.body]), [['answer', { key: 'q:toolu_01Cart', choice: 'Merge both carts' }]]);
    },
  },
  {
    name: 'P5.2.6 the server refuses an accept whose advice changed during the hold: 400 advice-changed, the toast Not sent to Merge guest cart on login: the second opinion changed; read it again, s-cart back as peek 1 marked Not sent, and Show brings it to the front with the banner',
    clock: 'fast',
    expectedErrors: [/status of 400/],
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await mock.post('/mock/advice', { id: 's-cart', state: 'done', choice: 'Merge both carts' });
      const [refused] = await logged(mock, 'the refused accept', (e) => e.action === 'accept-advice', POSTED_MS);
      assert.deepEqual([refused.status, refused.code], [400, 'advice-changed']);
      const [error] = await page.until('the error toast', toastsOf, 'error');
      assert.equal(error.text, 'Not sent to Merge guest cart on login: the second opinion changed; read it again\nShow');
      const [first] = await page.until('s-cart as peek 1', () => {
        const p = document.querySelector<HTMLElement>('[data-peek="1"]');
        return p?.dataset.session === 's-cart' && [p.innerText];
      });
      assert.match(first, /not sent/i);
      assert.equal((await page.eval(card))!.session, 's-hooks');
      await shot('queue-not-sent-peek');
      await page.click('[data-toast][data-kind="error"] button', 'Show');
      await page.until('s-cart at the front', frontIs, 's-cart');
      assert.equal(await page.eval(() => document.querySelector('[data-card] [data-not-sent]')?.textContent), 'Not sent: the second opinion changed; read it again');
      await page.until('the card to settle', still);
      await shot('queue-not-sent-banner');
    },
  },
  {
    name: 'P5.2.7 the key guard: ⏎ as the first card comes up does nothing; two ⏎ 300 ms apart hold one send, and two 650 ms apart one more while the card after it stays; an auto-repeated ⏎ does nothing, and a double click on an option holds it once',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.eval(pressEnter, []);
      await sleep(300);
      assert.deepEqual([(await page.eval(card))!.session, await page.eval(toastsOf, 'undo')], ['s-cart', null], 'the first card was not guarded');
      await ready(page, 's-cart');
      await page.eval(pressEnter, [300]);
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.equal((await page.eval(toastsOf, 'undo'))?.length, 1);
      await page.until('the guard to end', unguarded);
      await page.eval(pressEnter, [650]);
      await page.until('s-group at the front', frontIs, 's-group');
      await sleep(400);
      assert.equal((await page.eval(card))!.session, 's-group', 'the second ⏎ answered the card after it');
      await page.until('the guard to end', unguarded);
      await page.eval(pressEnter, [], true);
      await sleep(400);
      assert.equal((await page.eval(card))!.session, 's-group', 'an auto-repeated ⏎ answered');
      await page.dblclick('[data-card] [data-option="2"]');
      await page.until('s-astro at the front', frontIs, 's-astro');
      await sleep(HELD_MS + 600);
      assert.deepEqual((await actions(mock)).map((e) => [e.sessionId, e.action, e.body.choice ?? null]).toSorted(), [
        ['s-cart', 'accept-advice', null], ['s-group', 'answer', 'By repo'], ['s-hooks', 'answer-menu', null],
      ]);
    },
  },
  {
    name: 'P5.2.8 Space on a focused option shows or hides the details and holds nothing',
    clock: 'fast',
    async run({ wait, page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.eval(() => document.querySelector<HTMLElement>('[data-card] [data-option="2"]')!.focus());
      await page.key(' ');
      await page.until('the details hidden', () => document.querySelector('[data-card] section[aria-label="Claude\'s details"] button')?.getAttribute('aria-expanded') === 'false');
      assert.deepEqual([(await page.eval(card))!.session, await page.eval(toastsOf, 'undo')], ['s-cart', null]);
      await wait(HELD_MS);
      assert.deepEqual(await actions(mock), []);
    },
  },
  {
    name: 'P5.2.9 the menu: its picks start as the second opinion\'s, Accept suggestion; 4 unpicks Email the account owner, Send answer; Use the suggestion picks them again; an empty question 2 reads Answer both questions, off; picked again, ⏎ sends answer-menu with the picks on screen',
    clock: 'fast',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.key('ArrowRight');
      await ready(page, 's-hooks');
      const primary = () => [document.querySelector('[data-card] [data-primary]')?.firstElementChild?.textContent, document.querySelector<HTMLButtonElement>('[data-card] [data-primary]')?.disabled];
      const picks = () => [...document.querySelectorAll('[data-card] section[role="group"]')].map((q) => [...q.querySelectorAll('[aria-pressed="true"]')].map((o) => o.querySelector('span span')?.textContent));
      assert.deepEqual(await page.eval(primary), ['Accept suggestion', false]);
      await page.key('4');
      await page.until('Send answer', (label: string) => document.querySelector('[data-card] [data-primary]')?.firstElementChild?.textContent === label, 'Send answer');
      await page.click('[data-card] button', 'Use the suggestion');
      await page.until('Accept suggestion', (label: string) => document.querySelector('[data-card] [data-primary]')?.firstElementChild?.textContent === label, 'Accept suggestion');
      assert.deepEqual(await page.eval(picks), [['Exponential, 5 tries'], ['Email the account owner', 'Disable the endpoint']]);
      await page.key('4');
      await page.key('6');
      await page.until('Answer both questions', (label: string) => document.querySelector('[data-card] [data-primary]')?.firstElementChild?.textContent === label, 'Answer both questions');
      assert.deepEqual(await page.eval(primary), ['Answer both questions', true]);
      await page.key('5');
      await page.until('Send answer', (label: string) => document.querySelector('[data-card] [data-primary]')?.firstElementChild?.textContent === label, 'Send answer');
      const onScreen = await page.eval(picks);
      await shot('queue-menu-picks');
      await page.key('Enter');
      await page.until('s-group at the front', frontIs, 's-group');
      const [sent] = await logged(mock, 'the menu answer', (e) => e.action === 'answer-menu', POSTED_MS);
      assert.deepEqual([sent.status, sent.body.toolUseId], [204, 'toolu_01Hooks']);
      assert.deepEqual(sent.body.answers, onScreen.map((labels) => ({ labels, other: '' })));
      assert.deepEqual(onScreen, [['Exponential, 5 tries'], ['Post to #billing-alerts']]);
    },
  },
  {
    name: 'P5.2.10 a menu of one single-choice question: its digit holds answer-menu with that pick',
    clock: 'fast',
    scenario: 'lone-menu',
    async run({ page, mock }) {
      await openQueue(page, mock, 's-lone');
      await ready(page, 's-lone');
      await page.key('2');
      await page.until('the undo toast', toastsOf, 'undo');
      const [sent] = await logged(mock, 'the menu answer', (e) => e.action === 'answer-menu', POSTED_MS);
      assert.deepEqual([sent.status, sent.body], [204, { toolUseId: 'toolu_01Lone', answers: [{ labels: ['Every 15 min, 8 tries'], other: '' }] }]);
    },
  },
  {
    name: 'P5.2.11 your own answer: W, "Use the cache" and Enter hold answer with the key and the text, and the card deals out',
    clock: 'fast',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('Use the cache');
      await page.eval(watchDeals);
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.deepEqual(await page.eval(dealt), ['down']);
      assert.match((await page.until('the undo toast', toastsOf, 'undo'))[0].text, /^Sending: “Use the cache”/);
      assert.equal(await page.eval(() => document.activeElement?.closest('[data-card]')?.getAttribute('data-session') ?? null), 's-hooks', 'focus stayed on the page');
      const [sent] = await logged(mock, 'the answer', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.status, sent.body], [204, { key: 'q:toolu_01Cart', text: 'Use the cache' }]);
    },
  },
  {
    name: 'P5.2.12 a command: /compact and Enter hold it with a toast Sending: /compact, the card stays and its reply box is empty and says the question stays open; it goes out 5 s on; Z puts it back in the box instead',
    clock: 'fast',
    async run({ wait, page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      const command = async () => {
        await page.type('/compact');
        await page.until('the command list', () => [...document.querySelectorAll('[data-card] [role="option"] code')].some((c) => c.textContent === '/compact'));
        await page.key('Enter');
        return page.until('the undo toast', toastsOf, 'undo');
      };
      const [held] = await command();
      assert.match(held.text, /^Sending: \/compact\s*· [1-5] s/);
      assert.deepEqual(await page.eval(() => [
        document.querySelector<HTMLElement>('[data-card]')?.dataset.session, document.querySelector<HTMLTextAreaElement>('[data-card] textarea')?.value,
        document.querySelector('[data-card] [role="status"]')?.textContent,
      ]), ['s-cart', '', '/compact goes to the terminal as typed; the question stays open.']);
      await shot('queue-command');
      const [sent] = await logged(mock, 'the command', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.status, sent.body], [204, { key: 'q:toolu_01Cart', text: '/compact' }]);

      await command();
      await page.click('[data-card] h1');
      await page.key('z');
      await page.until('the command back in the box', () => document.querySelector<HTMLTextAreaElement>('[data-card] textarea')?.value === '/compact');
      assert.equal((await page.eval(card))!.session, 's-cart');
      await wait(6000);
      assert.equal((await actions(mock)).length, 1, 'the command taken back went out');
    },
  },
  {
    name: 'P5.2.13 Dismiss deals s-cart sideways with the toast Dismissing “…” and Undo, and 5 s on dismiss goes out with its key',
    clock: 'fast',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.eval(watchDeals);
      await page.click('[data-card] footer button', 'Dismiss');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.deepEqual(await page.eval(dealt), ['side']);
      assert.match((await page.until('the undo toast', toastsOf, 'undo'))[0].text, /^Dismissing “What should happen to a guest cart when the shopper logs in\?”\s*· [1-5] s\s+Undo\s+Esc$/);
      const [sent] = await logged(mock, 'the dismissal', (e) => e.action === 'dismiss', POSTED_MS);
      assert.deepEqual([sent.sessionId, sent.status, sent.body], ['s-cart', 204, { key: 'q:toolu_01Cart' }]);
    },
  },
  {
    name: 'P5.2.14 Your turn: ⏎ (Reply) focuses the reply box and Enter holds a message whose raw body has "key":null; X archives Fix broken doc anchors at once, its card goes sideways, and the toast\'s Undo unarchives it, as ⌘Z does after a second X',
    clock: 'fast',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.click('[data-segment][data-session="s-reviews"]');
      await ready(page, 's-reviews');
      // The segment keeps focus after the click, and ⏎ on it would press it again.
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.key('Enter');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('Commit it and open a PR');
      await page.key('Enter');
      await page.until('the undo toast', toastsOf, 'undo');
      const [sent] = await logged(mock, 'the message', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.sessionId, sent.status, sent.body], ['s-reviews', 204, { key: null, text: 'Commit it and open a PR' }]);
      assert.match(sent.raw ?? '', /"key":null/);

      await page.click('[data-segment][data-session="s-anchors"]');
      await ready(page, 's-anchors');
      await page.eval(watchDeals);
      const pressed = Date.now();
      await page.key('x');
      const [archived] = await logged(mock, 'the archive', (e) => e.action === 'archive');
      assert.deepEqual([archived.sessionId, archived.body, archived.status], ['s-anchors', { archived: true }, 204]);
      assert.ok(archived.at - pressed < 1000, `archived ${archived.at - pressed} ms after X`);
      await page.until('s-anchors gone', () => !document.querySelector('[data-card][data-session="s-anchors"]') && !document.documentElement.dataset.deal);
      assert.deepEqual(await page.eval(dealt), ['side']);
      const toast = await page.until('the archive toast', () => [...document.querySelectorAll<HTMLElement>('[data-toast][data-kind="undo"]')].find((t) => t.innerText.startsWith('Archived'))?.innerText);
      assert.equal(toast, 'Archived Fix broken doc anchors\nUndo\n⌘Z');
      await page.click('[data-toast][data-kind="undo"] button', 'Undo');
      const [back] = await logged(mock, 'the unarchive', (e) => e.action === 'archive' && e.body.archived === false);
      assert.deepEqual([back.sessionId, back.status], ['s-anchors', 204]);
      await page.until('s-anchors back at the front', frontIs, 's-anchors');

      await ready(page, 's-anchors');
      await page.key('x');
      await page.until('s-anchors archived again', () => !document.querySelector('[data-card][data-session="s-anchors"]') && !document.documentElement.dataset.deal);
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.key('z', { meta: true });
      await page.until('s-anchors back at the front by ⌘Z', frontIs, 's-anchors');
      const unarchives = await logged(mock, 'the second unarchive', (e) => e.action === 'archive' && e.body.archived === false && e.sessionId === 's-anchors' && e.at > back.at);
      assert.equal(unarchives.length, 1);
      assert.equal(await page.eval(() => document.querySelector('[data-segment][data-session="s-anchors"]') !== null), true, 's-anchors in the queue');
    },
  },
  {
    name: 'P5.2.15 a refused send: with /mock/fail stale, ⏎ on s-cart with a note gets a 400 at 5 s, an error toast, and s-cart comes back as peek 1 marked Not sent; Show brings it to the front with the banner and the note back in its reply box',
    clock: 'fast',
    expectedErrors: [/status of 400/],
    async run({ page, mock, shot }) {
      await mock.post('/mock/fail', { error: 'this question is no longer open', code: 'stale' });
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('only if stock allows');
      await page.click('[data-card] h1');
      assert.equal((await page.eval(card))!.primary, 'Send “Merge both carts” + your note');
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      const [refused] = await logged(mock, 'the refused answer', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([refused.status, refused.code, refused.body], [400, 'stale', { key: 'q:toolu_01Cart', choice: 'Merge both carts', text: 'only if stock allows' }]);
      const [error] = await page.until('the error toast', toastsOf, 'error');
      assert.equal(error.text, 'Not sent to Merge guest cart on login: this question is no longer open\nShow');
      assert.match(await page.until('s-cart as peek 1', () => {
        const p = document.querySelector<HTMLElement>('[data-peek="1"]');
        return p?.dataset.session === 's-cart' && p.innerText;
      }), /not sent/i);
      await page.click('[data-toast][data-kind="error"] button', 'Show');
      await page.until('s-cart at the front', frontIs, 's-cart');
      assert.equal(await page.eval(() => document.querySelector('[data-card] [data-not-sent]')?.textContent), 'Not sent: this question is no longer open');
      assert.deepEqual({ ...(await page.eval(replyIn, '[data-card]')), focused: undefined }, { value: 'only if stock allows', files: [], focused: undefined });
      await page.until('the card to settle', still);
      await shot('queue-refused');
    },
  },
  {
    name: 'P5.2.16 the early check: an answer held on s-group whose turn moves on (lastTurn t9) fails with Not sent to Group board tiles by repo: this question is no longer open, and nothing is posted',
    clock: 'fast',
    async run({ wait, page, mock }) {
      await openQueue(page, mock);
      await page.click('[data-peek="2"] > span');
      await ready(page, 's-group');
      await page.key('1');
      await page.until('s-astro at the front', frontIs, 's-astro');
      await mock.post('/mock/patch', { id: 's-group', patch: { lastTurn: 't9' } });
      const [error] = await page.until('the error toast', toastsOf, 'error');
      assert.equal(error.text, 'Not sent to Group board tiles by repo: this question is no longer open\nShow');
      await wait(HELD_MS);
      assert.deepEqual(await actions(mock), []);
    },
  },
  {
    name: 'P5.2.16-working the early check when the session went on working: Show opens its sheet on Overview, and the answer it held is back in the sheet\'s reply box',
    clock: 'fast',
    async run({ wait, page, mock }) {
      await openQueue(page, mock);
      await page.click('[data-peek="2"] > span');
      await ready(page, 's-group');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('Group by repo, attention inside');
      await page.key('Enter');
      await page.until('s-astro at the front', frontIs, 's-astro');
      await mock.post('/mock/patch', { id: 's-group', patch: { lastTurn: 't9', status: 'working', activity: { step: 'Edit web/src/order.ts', since: Date.now() } } });
      const [error] = await page.until('the error toast', toastsOf, 'error');
      assert.equal(error.text, 'Not sent to Group board tiles by repo: this question is no longer open\nShow');
      await page.click('[data-toast][data-kind="error"] button', 'Show');
      await page.until('the sheet of s-group', () => location.pathname === '/s/s-group/overview' && !!document.querySelector('#task-sheet'));
      assert.deepEqual({ ...(await page.eval(replyIn, '#task-sheet')), focused: undefined }, { value: 'Group by repo, attention inside', files: [], focused: undefined });
      await wait(HELD_MS);
      assert.deepEqual(await actions(mock), []);
    },
  },
  {
    name: 'P5.2.17 answered elsewhere: a send held on s-cart whose decision another window answers is dropped with word that it was already answered, and nothing is posted',
    clock: 'fast',
    async run({ wait, page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await mock.post('/mock/patch', { id: 's-cart', patch: { answered: { key: 'q:toolu_01Cart', text: 'Merge both carts', at: Date.now() } } });
      const [info] = await page.until('the toast', toastsOf, 'info');
      assert.equal(info.text, 'Already answered elsewhere; nothing was sent to Merge guest cart on login');
      assert.equal(await page.eval(toastsOf, 'undo'), null);
      await wait(HELD_MS);
      assert.deepEqual(await actions(mock), []);
    },
  },
  {
    name: 'P5.2.18 reconnecting: a send held as the connection drops for 8 s waits for Pitwall at about 5 s, and goes out once, after the pill reads Live again',
    expectedErrors: [/WebSocket/, /ERR_/],
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('Enter');
      const pressed = Date.now();
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await mock.post('/mock/drop', { ms: 8000 });
      try {
        await page.until('the pill to turn reconnecting', pillAt, 'reconnecting');
        const [waiting] = await until('the waiting toast', () => page.eval(toastsOf, 'info'), 8000);
        const at = Date.now() - pressed;
        assert.ok(at > 4500 && at < 7000, `waiting after ${at} ms`);
        assert.equal(waiting.text, 'Waiting for Pitwall to send “Merge both carts” to Merge guest cart on login');
      } finally {
        await until('the drop to end', () => mock.get('/mock').then(() => true, () => false), 10_000);
      }
      await until('the pill to turn live again', () => page.eval(pillAt, 'live'), 10_000);
      const sent = await until('the post', async () => {
        const posted = await actions(mock);
        return posted.length && posted;
      }, POSTED_MS);
      assert.deepEqual(sent.map((e) => [e.action, e.sessionId, e.status]), [['accept-advice', 's-cart', 204]]);
      assert.ok(sent[0].at - pressed > 8000, `posted ${sent[0].at - pressed} ms after ⏎, inside the drop`);
      await sleep(1000);
      assert.equal((await actions(mock)).length, 1);
    },
  },
  {
    name: 'P5.2.19 pagehide: an option pressed, then the page left within 1 s, still reaches the server at once: the page posts what it holds as it goes',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('1');
      const pressed = Date.now();
      await sleep(300);
      await page.goto('about:blank');
      const [sent] = await logged(mock, 'the answer posted on pagehide', (e) => e.action === 'accept-advice');
      assert.deepEqual([sent.sessionId, sent.status], ['s-cart', 204]);
      assert.ok(sent.at - pressed < 2000, `posted ${sent.at - pressed} ms after the press`);
    },
  },
];
