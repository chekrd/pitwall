import assert from 'node:assert/strict';
import { sleep, until } from '../cdp.ts';
import {
  actions, byText, decision, decisionOf, HELD_MS, logged, matches, noDecision, openDecision, openSheetOf, pastePng, pillAt, POSTED_MS, pressEnter, ready, replyIn, still, toastsOf, unguarded,
  type Check,
} from '../helpers.ts';

export const sends: Check[] = [
  {
    name: 'P5.2.1 ⏎ on s-cart\'s page holds its answer and the decision leaves the page; the toast says Sending: “Merge both carts” on one line of a set width, counts down and offers Undo Esc; Next decision counts the 2 others; 5 s on, one answer goes out with the option Claude recommends',
    async run({ page, mock, shot }) {
      await openDecision(page, mock);
      await page.key('Enter');
      const pressed = Date.now();
      await page.until('the decision to go', noDecision, 's-cart');
      const [held] = await page.until('the undo toast', toastsOf, 'undo');
      assert.match(held.text, /^Sending: “Merge both carts”\s*· [1-5] s\s+Undo\s+Esc$/);
      const count = () => Number(document.querySelector('[data-toast][data-kind="undo"]')?.textContent?.match(/· (\d) s/)?.[1]);
      const first = await page.eval(count);
      // The countdown follows the shared clock, which ticks once a second at its own phase.
      await until('the countdown to count down', async () => (await page.eval(count)) < first, 2100);
      assert.deepEqual(await page.eval(() => [document.querySelector<HTMLElement>('header [data-next-decision]')?.innerText.replace(/\s+/g, ' ').trim(), document.title]), [
        'Next decision 2 D', 'Pitwall',
      ]);
      await shot('task-held');
      const sent = await logged(mock, 'the held send', (e) => e.method === 'POST' && e.action !== null, POSTED_MS);
      assert.deepEqual(sent.map((e) => [e.action, e.sessionId, e.body, e.status]), [['answer', 's-cart', { key: 'q:toolu_01Cart', choice: 'Merge both carts' }, 204]]);
      assert.ok(sent[0].at - pressed >= 4900, `posted ${sent[0].at - pressed} ms after ⏎`);
    },
  },
  {
    name: 'P5.2.2 Undo gives back what the send took: option 2 with a note and a pasted picture held, Z within 3 s brings s-cart\'s decision back with both in the reply box and nothing goes out; sent again, the answer carries the choice, the note and the picture',
    clock: 'fast',
    async run({ holds, page, mock }) {
      await openDecision(page, mock);
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-decision] textarea'));
      await page.type('only if stock allows');
      await page.eval(pastePng, '[data-decision] textarea');
      await page.until('the picture uploaded', () => !!document.querySelector('[data-decision] [data-state="ready"]'));
      await page.click('[data-decision] [data-option="2"]');
      const pressed = Date.now();
      await page.until('the decision to go', noDecision, 's-cart');
      await page.key('z');
      await page.until('the decision back', decisionOf, 's-cart');
      assert.ok(Date.now() - pressed < 3000, `back ${Date.now() - pressed} ms after the press`);
      assert.deepEqual({ ...(await page.eval(replyIn, '[data-decision]')), focused: undefined }, { value: 'only if stock allows', files: ['ready shot.png'], focused: undefined });
      assert.equal(await page.eval(() => document.querySelector('[data-toast][data-kind="undo"]')), null, 'the undo toast stayed');
      await holds('nothing to go out', 6000, async () => !(await actions(mock)).length);

      await page.until('the guard to end', unguarded);
      await page.click('[data-decision] [data-option="2"]');
      await page.until('the decision to go', noDecision, 's-cart');
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
    name: 'P5.2.7 the key guard: ⏎ as the decision comes up does nothing; two ⏎ 300 ms apart hold one send; on the next decision two ⏎ 650 ms apart hold one more and leave the decision after it alone; an auto-repeated ⏎ does nothing, and a double click on an option holds it once',
    async run({ holds, page, mock }) {
      await page.goto(`${mock.url}/s/s-cart/overview`);
      await page.until('the decision of s-cart', decisionOf, 's-cart');
      await page.eval(pressEnter, []);
      await holds('the ⏎ as the decision comes up to do nothing', 300, async () => matches([(await page.eval(decision))!.session, await page.eval(toastsOf, 'undo')], ['s-cart', null]));
      await page.until('the guard to end', unguarded);
      await page.eval(pressEnter, [300]);
      await page.until('the decision to go', noDecision, 's-cart');
      assert.equal((await page.eval(toastsOf, 'undo'))?.length, 1);

      await page.key('d');
      await ready(page, 's-hooks');
      await page.click('[data-decision] [data-option="1"]');
      await page.click('[data-decision] [data-option="4"]');
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.eval(pressEnter, [650]);
      await page.until('the menu to go', noDecision, 's-hooks');
      await page.key('d');
      await page.until('s-group', decisionOf, 's-group');
      await holds('the second ⏎ to leave the decision after it', 400, async () => (await page.eval(decision))?.session === 's-group');
      await page.until('the guard to end', unguarded);
      await page.eval(pressEnter, [], true);
      await holds('an auto-repeated ⏎ to do nothing', 400, async () => (await page.eval(decision))?.session === 's-group');
      await page.dblclick('[data-decision] [data-option="2"]');
      await page.until('s-group\'s decision to go', noDecision, 's-group');
      await until('the three held sends', async () => (await actions(mock)).length >= 3, POSTED_MS);
      assert.deepEqual((await actions(mock)).map((e) => [e.sessionId, e.action, e.body.choice ?? null]).toSorted(byText), [
        ['s-cart', 'answer', 'Merge both carts'], ['s-group', 'answer', 'By repo'], ['s-hooks', 'answer-menu', null],
      ]);
    },
  },
  {
    name: 'P5.2.8 Space on a focused option shows or hides the details and holds nothing',
    clock: 'fast',
    async run({ holds, page, mock }) {
      await openDecision(page, mock);
      await page.eval(() => document.querySelector<HTMLElement>('[data-decision] [data-option="2"]')!.focus());
      await page.key(' ');
      await page.until('the details hidden', () => document.querySelector('[data-decision] section[aria-label="Claude\'s details"] button')?.getAttribute('aria-expanded') === 'false');
      assert.deepEqual([(await page.eval(decision))!.session, await page.eval(toastsOf, 'undo')], ['s-cart', null]);
      await holds('nothing to go out', HELD_MS, async () => !(await actions(mock)).length);
    },
  },
  {
    name: 'P5.2.10 a menu of one single-choice question: a click on an option holds answer-menu with that pick, as the terminal answers it',
    clock: 'fast',
    scenario: 'lone-menu',
    async run({ page, mock }) {
      await openDecision(page, mock, 's-lone');
      assert.equal(await page.eval(() => !!document.querySelector('[data-decision] [data-primary]')), false, 'a pick sends, so there is no main button');
      await page.click('[data-decision] [data-option="2"]');
      await page.until('the undo toast', toastsOf, 'undo');
      const [sent] = await logged(mock, 'the menu answer', (e) => e.action === 'answer-menu', POSTED_MS);
      assert.deepEqual([sent.status, sent.body], [204, { toolUseId: 'toolu_01Lone', answers: [{ labels: ['Every 15 min, 8 tries'], other: '' }] }]);
    },
  },
  {
    name: 'P5.2.11 your own answer: W, "Use the cache" and Enter hold answer with the key and the text, the decision leaves the page and focus stays on it',
    clock: 'fast',
    async run({ page, mock }) {
      await openDecision(page, mock);
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-decision] textarea'));
      await page.type('Use the cache');
      await page.key('Enter');
      await page.until('the decision to go', noDecision, 's-cart');
      assert.match((await page.until('the undo toast', toastsOf, 'undo'))[0].text, /^Sending: “Use the cache”/);
      assert.equal(await page.eval(() => document.activeElement?.id), 'task-sheet', 'focus stayed on the page');
      const [sent] = await logged(mock, 'the answer', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.status, sent.body], [204, { key: 'q:toolu_01Cart', text: 'Use the cache' }]);
    },
  },
  {
    name: 'P5.2.12 a command: /compact and Enter hold it with a toast Sending: /compact, the decision stays and its reply box is empty and says the question stays open; it goes out 5 s on; Z puts it back in the box instead',
    clock: 'fast',
    async run({ holds, page, mock, shot }) {
      await openDecision(page, mock);
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-decision] textarea'));
      const command = async () => {
        await page.type('/compact');
        await page.until('the command list', () => [...document.querySelectorAll('[data-decision] [role="option"] code')].some((c) => c.textContent === '/compact'));
        await page.key('Enter');
        return page.until('the undo toast', toastsOf, 'undo');
      };
      const [held] = await command();
      assert.match(held.text, /^Sending: \/compact\s*· [1-5] s/);
      assert.deepEqual(await page.eval(() => [
        document.querySelector<HTMLElement>('[data-decision]')?.dataset.session, document.querySelector<HTMLTextAreaElement>('[data-decision] textarea')?.value,
        document.querySelector('[data-decision] [role="status"]')?.textContent,
      ]), ['s-cart', '', '/compact goes to the terminal as typed; the question stays open.']);
      await shot('task-command');
      const [sent] = await logged(mock, 'the command', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.status, sent.body], [204, { key: 'q:toolu_01Cart', text: '/compact' }]);

      await command();
      await page.click('[data-decision] h3');
      await page.key('z');
      await page.until('the command back in the box', () => document.querySelector<HTMLTextAreaElement>('[data-decision] textarea')?.value === '/compact');
      assert.equal((await page.eval(decision))!.session, 's-cart');
      await holds('the command taken back to stay', 6000, async () => (await actions(mock)).length === 1);
    },
  },
  {
    name: 'P5.2.13 Dismiss takes s-cart\'s decision off its page with the toast Dismissing “…” and Undo, and 5 s on dismiss goes out with its key',
    clock: 'fast',
    async run({ page, mock }) {
      await openDecision(page, mock);
      await page.click('[data-decision] button', 'Dismiss');
      await page.until('the decision to go', noDecision, 's-cart');
      assert.match((await page.until('the undo toast', toastsOf, 'undo'))[0].text, /^Dismissing “Guest cart or account cart when a shopper logs in\?”\s*· [1-5] s\s+Undo\s+Esc$/);
      const [sent] = await logged(mock, 'the dismissal', (e) => e.action === 'dismiss', POSTED_MS);
      assert.deepEqual([sent.sessionId, sent.status, sent.body], ['s-cart', 204, { key: 'q:toolu_01Cart' }]);
    },
  },
  {
    name: 'P5.2.14 Your turn: Message Claude on Lazy-load product reviews\' page holds a message whose raw body has "key":null; Archive in the ⋯ menu archives Fix broken doc anchors at once, and the toast\'s Undo unarchives it, as ⌘Z does after a second Archive',
    clock: 'fast',
    async run({ page, mock }) {
      await openSheetOf(page, mock, 's-reviews');
      await page.click('#task-sheet section[aria-label="Message Claude"] textarea');
      await page.type('Commit it and open a PR');
      await page.key('Enter');
      await page.until('the undo toast', toastsOf, 'undo');
      const [sent] = await logged(mock, 'the message', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.sessionId, sent.status, sent.body], ['s-reviews', 204, { key: null, text: 'Commit it and open a PR' }]);
      assert.match(sent.raw ?? '', /"key":null/);

      const archive = async () => {
        await page.click('#task-sheet button[aria-label="Session actions"]');
        await page.until('the ⋯ menu', () => !!document.querySelector(':popover-open'));
        const pressed = Date.now();
        await page.click(':popover-open button', 'Archive');
        return pressed;
      };
      await openSheetOf(page, mock, 's-anchors');
      const pressed = await archive();
      const [archived] = await logged(mock, 'the archive', (e) => e.action === 'archive');
      assert.deepEqual([archived.sessionId, archived.body, archived.status], ['s-anchors', { archived: true }, 204]);
      assert.ok(archived.at - pressed < 1000, `archived ${archived.at - pressed} ms after the press`);
      const toast = await page.until('the archive toast', () => [...document.querySelectorAll<HTMLElement>('[data-toast][data-kind="undo"]')].find((t) => t.innerText.startsWith('Archived'))?.innerText);
      assert.equal(toast, 'Archived Fix broken doc anchors\nUndo\n⌘Z');
      await page.click('[data-toast][data-kind="undo"] button', 'Undo');
      const [back] = await logged(mock, 'the unarchive', (e) => e.action === 'archive' && e.body.archived === false);
      assert.deepEqual([back.sessionId, back.status], ['s-anchors', 204]);

      await archive();
      await page.until('the archive toast again', () => [...document.querySelectorAll<HTMLElement>('[data-toast][data-kind="undo"]')].some((t) => t.innerText.startsWith('Archived')));
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.key('z', { meta: true });
      const unarchives = await logged(mock, 'the second unarchive', (e) => e.action === 'archive' && e.body.archived === false && e.sessionId === 's-anchors' && e.at > back.at);
      assert.equal(unarchives.length, 1);
      await page.key('Escape');
      await page.until('the tile of s-anchors among the live ones', () => !!document.querySelector('[data-tile][data-session="s-anchors"]:not([data-archived])'));
    },
  },
  {
    name: 'P5.2.15 a refused send: with /mock/fail stale, ⏎ on s-cart with a note gets a 400 at 5 s and an error toast; the decision comes back on its page marked Not sent, with the note back in its reply box, and Show on the toast from the Wall opens it',
    clock: 'fast',
    expectedErrors: [/status of 400/],
    async run({ page, mock, shot }) {
      await mock.post('/mock/fail', { error: 'this question is no longer open', code: 'stale' });
      await openDecision(page, mock);
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-decision] textarea'));
      await page.type('only if stock allows');
      await page.click('[data-decision] h3');
      assert.equal((await page.eval(decision))!.primary, 'Send “Merge both carts” + your note');
      await page.key('Enter');
      await page.until('the decision to go', noDecision, 's-cart');
      const [refused] = await logged(mock, 'the refused answer', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([refused.status, refused.code, refused.body], [400, 'stale', { key: 'q:toolu_01Cart', choice: 'Merge both carts', text: 'only if stock allows' }]);
      const [error] = await page.until('the error toast', toastsOf, 'error');
      assert.equal(error.text, 'Not sent to Merge guest cart on login: this question is no longer open\nShow');
      await page.until('the decision back', decisionOf, 's-cart');
      assert.equal(await page.eval(() => document.querySelector('[data-decision] [data-not-sent]')?.textContent), 'Not sent: this question is no longer open');
      assert.deepEqual({ ...(await page.eval(replyIn, '[data-decision]')), focused: undefined }, { value: 'only if stock allows', files: [], focused: undefined });
      await page.until('the page to settle', still);
      await shot('task-refused');
      await page.key('Escape');
      await page.until('the Wall', () => !document.querySelector('#task-sheet'));
      await page.click('[data-toast][data-kind="error"] button', 'Show');
      await page.until('s-cart\'s page', decisionOf, 's-cart');
    },
  },
  {
    name: 'P5.2.16 the early check: an answer held on s-group whose question is replaced fails with Not sent to Group board tiles by repo: this question is no longer open, and nothing is posted',
    clock: 'fast',
    async run({ holds, page, mock }) {
      await openDecision(page, mock, 's-group');
      await page.click('[data-decision] [data-option="1"]');
      await page.until('the decision to go', noDecision, 's-group');
      await mock.post('/mock/patch', { id: 's-group', patch: { question: { toolUseId: 'toolu_02Group' } } });
      const [error] = await page.until('the error toast', toastsOf, 'error');
      assert.equal(error.text, 'Not sent to Group board tiles by repo: this question is no longer open\nShow');
      await holds('nothing to go out', HELD_MS, async () => !(await actions(mock)).length);
    },
  },
  {
    name: 'P5.2.16-working the early check when the session went on working: Show opens its page on Overview, and the answer it held is back in its reply box',
    clock: 'fast',
    async run({ holds, page, mock }) {
      await openDecision(page, mock, 's-group');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-decision] textarea'));
      await page.type('Group by repo, attention inside');
      await page.key('Enter');
      await page.until('the decision to go', noDecision, 's-group');
      await page.click('#task-sheet header button[aria-label="Back to the Wall"]');
      await page.until('the Wall', () => !document.querySelector('#task-sheet'));
      await mock.post('/mock/patch', { id: 's-group', patch: { question: null, lastTurn: 't9', status: 'working', activity: { step: 'Edit web/src/order.ts', since: Date.now() } } });
      const [error] = await page.until('the error toast', toastsOf, 'error');
      assert.equal(error.text, 'Not sent to Group board tiles by repo: this question is no longer open\nShow');
      await page.click('[data-toast][data-kind="error"] button', 'Show');
      await page.until('the page of s-group', () => location.pathname === '/s/s-group/overview' && !!document.querySelector('#task-sheet'));
      assert.deepEqual({ ...(await page.eval(replyIn, '#task-sheet')), focused: undefined }, { value: 'Group by repo, attention inside', files: [], focused: undefined });
      await holds('nothing to go out', HELD_MS, async () => !(await actions(mock)).length);
    },
  },
  {
    name: 'P5.2.17 answered elsewhere: a send held on s-cart whose decision another window answers is dropped with word that it was already answered, and nothing is posted',
    clock: 'fast',
    async run({ holds, page, mock }) {
      await openDecision(page, mock);
      await page.key('Enter');
      await page.until('the decision to go', noDecision, 's-cart');
      await mock.post('/mock/patch', { id: 's-cart', patch: { answered: { key: 'q:toolu_01Cart', text: 'Merge both carts', at: Date.now() } } });
      const [info] = await page.until('the toast', toastsOf, 'info');
      assert.equal(info.text, 'Already answered elsewhere; nothing was sent to Merge guest cart on login');
      assert.equal(await page.eval(toastsOf, 'undo'), null);
      await holds('nothing to go out', HELD_MS, async () => !(await actions(mock)).length);
    },
  },
  {
    name: 'P5.2.18 reconnecting: a send held as the connection drops for 8 s waits for Pitwall at about 5 s, and goes out once, after the pill reads Live again',
    expectedErrors: [/WebSocket/, /ERR_/],
    async run({ holds, page, mock }) {
      await openDecision(page, mock);
      await page.key('Enter');
      const pressed = Date.now();
      await page.until('the decision to go', noDecision, 's-cart');
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
      assert.deepEqual(sent.map((e) => [e.action, e.sessionId, e.status]), [['answer', 's-cart', 204]]);
      assert.ok(sent[0].at - pressed > 8000, `posted ${sent[0].at - pressed} ms after ⏎, inside the drop`);
      await holds('the send to go out once', 1000, async () => (await actions(mock)).length === 1);
    },
  },
  {
    name: 'P5.2.19 pagehide: an option pressed, then the page left within 1 s, still reaches the server at once: the page posts what it holds as it goes',
    async run({ page, mock }) {
      await openDecision(page, mock);
      await page.click('[data-decision] [data-option="1"]');
      const pressed = Date.now();
      await sleep(300);
      await page.goto('about:blank');
      const [sent] = await logged(mock, 'the answer posted on pagehide', (e) => e.action === 'answer');
      assert.deepEqual([sent.sessionId, sent.status], ['s-cart', 204]);
      assert.ok(sent.at - pressed < 2000, `posted ${sent.at - pressed} ms after the press`);
    },
  },
];
