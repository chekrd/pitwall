import assert from 'node:assert/strict';
import { until } from '../cdp.ts';
import { actions, card, frontIs, HELD_MS, logged, openFromWall, openNewTask, openQueue, pastePng, POSTED_MS, reachable, ready, replyIn, settled, sheetOpen, sidewaysScroll, stateOf, still, tiles, toastsOf, unguarded, type Check } from '../helpers.ts';

export const replies: Check[] = [
  {
    name: 'P5.2.20 the reload gate: a new build announced while a send is held does not reload the page until it went out, and then it does',
    clock: 'fast',
    async run({ wait, page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.eval(() => void ((window as unknown as { e2eProbe?: number }).e2eProbe = 1));
      await page.key('1');
      const pressed = Date.now();
      await page.until('the undo toast', toastsOf, 'undo');
      await mock.post('/mock/ui-entry', { src: '/assets/next.js' });
      await wait(2000);
      assert.equal(await page.eval(() => (window as unknown as { e2eProbe?: number }).e2eProbe), 1, 'reloaded with a send held');
      const loadedAt = await until('the page to reload', async () => {
        try {
          return await page.eval(() => ((window as unknown as { e2eProbe?: number }).e2eProbe === undefined && document.readyState === 'complete' ? performance.timeOrigin : 0));
        } catch {
          return 0;
        }
      }, 7000 - (Date.now() - pressed));
      const [sent] = await logged(mock, 'the held answer', (e) => e.action === 'accept-advice');
      assert.equal(sent.status, 204);
      assert.ok(sent.at < loadedAt, `the answer went out ${sent.at - loadedAt} ms after the reload`);
    },
  },
  {
    name: 'P5.2.21 In your queue: O on s-cart opens Overview with In your queue · Decision, the problem, its options with the second opinion on Merge both carts, a reply box, Dismiss and Open its card; Open its card closes the sheet with s-cart at the front, also from over the Wall; an option pressed on the page is held with Undo and goes out with its key',
    clock: 'fast',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('o');
      await page.until('the sheet', () => location.pathname === '/s/s-cart/overview' && !!document.querySelector('#task-sheet'));
      const box = () => {
        const q = document.querySelector<HTMLElement>('#task-sheet [data-queued]');
        return q && {
          text: [...q.querySelectorAll(':scope > span, :scope > h3')].map((c) => c.textContent),
          options: [...q.querySelectorAll('[data-option]')].map((o) => o.textContent ?? ''),
          suggested: q.querySelector('[data-suggestion]')?.textContent?.includes('CHK-412') ?? false,
          reply: !!q.querySelector('textarea'),
          actions: [...q.querySelectorAll(':scope > div:last-child button')].map((b) => b.textContent),
        };
      };
      const shown = await page.until('the queue box', box);
      assert.deepEqual(shown.text, ['In your queue · Decision', 'What should happen to a guest cart when the shopper logs in?']);
      for (const label of ['Merge both carts', 'Keep the account cart']) assert.ok(shown.options.some((o) => o.includes(label)), `${label} in ${shown.options}`);
      assert.deepEqual([shown.suggested, shown.reply, shown.actions], [true, true, ['Dismiss', 'Open its card']]);
      await page.until('the sheet to settle', settled);
      await shot('sheet-in-your-queue');
      await page.click('#task-sheet [data-queued] button', 'Open its card');
      await page.until('the queue with s-cart at the front', () => !document.querySelector('#task-sheet') && location.pathname === '/' && document.querySelector<HTMLElement>('[data-card]')?.dataset.session === 's-cart');

      // A task that starts asking while its page is open over the Wall.
      await openFromWall(page, mock, 's-invoice');
      await mock.post('/mock/patch', {
        id: 's-invoice',
        patch: { status: 'idle', activity: null, question: { toolUseId: 'toolu_inv', category: 'plan-problem', askedAt: Date.now(), title: 'Round half cents to even?', details: '', options: [{ label: 'Yes' }, { label: 'No' }] } },
      });
      assert.deepEqual((await page.until('the queue box', box))?.text.slice(0, 2), ['In your queue · Decision', 'Round half cents to even?']);
      await page.click('#task-sheet [data-queued] button', 'Open its card');
      await page.until('the queue with s-invoice at the front', () => !document.querySelector('#task-sheet') && location.pathname === '/' && document.querySelector<HTMLElement>('[data-card]')?.dataset.session === 's-invoice');
      await page.eval(() => history.back());
      await page.until('the Wall again on Back', () => location.pathname === '/wall' && !document.querySelector('#task-sheet'));

      await page.goto(`${mock.url}/s/s-hooks/overview`);
      assert.deepEqual((await page.until('the queue box', box))?.text.slice(0, 1), ['In your queue · Asked in the terminal']);
      assert.ok((await page.eval(box))!.options.length > 1, 'the menu\'s options');

      await page.goto(`${mock.url}/s/s-cart/overview`);
      await page.until('the queue box', box);
      await page.click('#task-sheet [data-queued] [data-option]', 'Keep the account cart');
      await page.until('the undo toast', toastsOf, 'undo');
      await page.until('the box gone while it is held', () => !document.querySelector('#task-sheet [data-queued]'));
      const [answer] = await logged(mock, 'the answer', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([answer.sessionId, answer.body], ['s-cart', { key: 'q:toolu_01Cart', choice: 'Keep the account cart' }]);
    },
  },
  {
    name: 'P5.2.21b In your queue: a menu that replaces another in one snapshot starts with its own picks on the task page, as on the card, and the choice each first showed is frozen',
    async run({ page, mock }) {
      const pressed = () => [...document.querySelectorAll('#task-sheet [data-queued] [data-option][aria-pressed="true"]')].map((b) => b.textContent ?? '');
      const frozen = (key: string) => {
        try {
          return (JSON.parse(sessionStorage.getItem('pitwall:frozen') ?? '[]') as [string, unknown][]).some(([k]) => k === key);
        } catch {
          return false;
        }
      };
      await page.goto(`${mock.url}/s/s-hooks/overview`);
      await page.until('the second opinion\'s picks', () => document.querySelectorAll('#task-sheet [data-queued] [data-option][aria-pressed="true"]').length === 3);
      await page.click('#task-sheet [data-queued] [data-option]', 'Linear, 6 tries');
      await page.until('Linear picked', () => [...document.querySelectorAll('#task-sheet [data-queued] [data-option][aria-pressed="true"]')].some((b) => b.textContent?.includes('Linear, 6 tries')));
      await page.until('the menu frozen', frozen, 'm:toolu_01Hooks');

      const { menu } = await stateOf(mock, 's-hooks');
      await mock.post('/mock/patch', { id: 's-hooks', patch: { menu: { ...menu, toolUseId: 'toolu_02Hooks', at: Date.now() } } });
      await page.until('the new menu frozen', frozen, 'm:toolu_02Hooks');
      assert.deepEqual(await page.eval(pressed), [], 'the picks made on the menu before carried over');
    },
  },
  {
    name: 'P5.2.22 the sheet\'s reply box: a message typed in Fix invoice PDF rounding and Enter shows a toast with Undo in the sheet, which stays open, and 5 s on answer goes out with "key":null and the text',
    clock: 'fast',
    async run({ page, mock, shot }) {
      await openFromWall(page, mock, 's-invoice');
      await page.click('#task-sheet textarea');
      await page.type('Also round the tax lines');
      await page.key('Enter');
      const [held] = await page.until('the undo toast', toastsOf, 'undo');
      assert.deepEqual({ ...held, text: undefined }, { kind: 'undo', text: undefined, inSheet: false, hit: true });
      assert.match(held.text, /^Sending: “Also round the tax lines”\s*· [1-5] s\s+Undo\s+Esc$/);
      assert.deepEqual([await page.eval(sheetOpen), (await page.eval(replyIn, '#task-sheet'))?.value], [true, '']);
      await shot('sheet-held');
      const [sent] = await logged(mock, 'the message', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.sessionId, sent.status, sent.body], ['s-invoice', 204, { key: null, text: 'Also round the tax lines' }]);
      assert.match(sent.raw ?? '', /"key":null/);
      assert.equal(await page.eval(sheetOpen), true);
    },
  },
  {
    name: 'P5.2.27 the sheet\'s reply box stays the field you write in: a task that starts asking while you are in Message Claude keeps that very box, with focus, so a dictation that started in it still lands; the decision\'s own box comes once you leave it',
    async run({ page, mock }) {
      await openFromWall(page, mock, 's-invoice');
      await page.click('#task-sheet textarea[data-draft]');
      await page.type('Round');
      await page.eval(() => void (document.querySelector<HTMLTextAreaElement>('#task-sheet textarea[data-draft]')!.dataset.mark = 'first'));
      await mock.post('/mock/patch', {
        id: 's-invoice',
        patch: { status: 'idle', activity: null, question: { toolUseId: 'toolu_inv', category: 'plan-problem', askedAt: Date.now(), title: 'Round half cents to even?', details: '', options: [{ label: 'Yes' }, { label: 'No' }] } },
      });
      await page.until('the decision', () => !!document.querySelector('#task-sheet [data-queued] h3'));
      await page.type(' half up');
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll<HTMLTextAreaElement>('#task-sheet textarea[data-draft]')].map((t) => [t.dataset.mark ?? null, t.value, t === document.activeElement])), [['first', 'Round half up', true]]);
      await page.eval(() => document.getElementById('task-sheet')!.focus());
      await page.until('the decision\'s own box', () => document.querySelector<HTMLTextAreaElement>('#task-sheet [data-queued] textarea[data-draft]')?.value === 'Round half up');
      assert.equal(await page.eval(() => document.querySelectorAll('#task-sheet textarea[data-draft]').length), 1, 'Message Claude gone once left');
    },
  },
  {
    name: 'P5.2.28 a permission prompt while you are in Message Claude keeps that very box, with focus and its text, until you leave it',
    async run({ page, mock }) {
      await openFromWall(page, mock, 's-invoice');
      await page.click('#task-sheet textarea[data-draft]');
      await page.type('Round');
      await page.eval(() => void (document.querySelector<HTMLTextAreaElement>('#task-sheet textarea[data-draft]')!.dataset.mark = 'first'));
      await mock.post('/mock/patch', { id: 's-invoice', patch: { status: 'waiting', waitingFor: 'a permission prompt for Bash(pnpm test)' } });
      await page.until('the prompt notice', () => !!document.querySelector('#task-sheet p strong')?.textContent?.includes('pnpm test'));
      await page.type(' half');
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll<HTMLTextAreaElement>('#task-sheet textarea[data-draft]')].map((t) => [t.dataset.mark ?? null, t.value, t === document.activeElement])), [['first', 'Round half', true]]);
      await page.eval(() => document.getElementById('task-sheet')!.focus());
      await page.until('the box gone once left', () => !document.querySelector('#task-sheet textarea[data-draft]'));
    },
  },
  {
    name: 'P5.2.29 a paste on the task\'s page, with focus outside any field, goes into its only reply box at the caret',
    async run({ page, mock }) {
      await openFromWall(page, mock, 's-invoice');
      await page.click('#task-sheet textarea');
      await page.type('Round half up');
      await page.eval(() => {
        const box = document.querySelector<HTMLTextAreaElement>('#task-sheet textarea')!;
        box.setSelectionRange(5, 5);
        document.getElementById('task-sheet')!.focus();
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', ' every cent');
        document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      });
      assert.equal(await page.eval(() => document.querySelector<HTMLTextAreaElement>('#task-sheet textarea')!.value), 'Round every cent half up');
      assert.equal(await page.eval(() => document.activeElement === document.querySelector('#task-sheet textarea')), true, 'focus in the box');
    },
  },
  {
    name: 'P5.2.31 a paste into the reply box lands from the paste event itself, at the caret, though the browser\'s own insert comes up empty, and undo takes it back',
    async run({ page, mock }) {
      await openFromWall(page, mock, 's-invoice');
      await page.click('#task-sheet textarea');
      await page.type('Round half up');
      // A dispatched paste carries the text but has no insert of its own, as a paste whose clipboard read came back empty.
      const prevented = await page.eval(() => {
        const box = document.querySelector<HTMLTextAreaElement>('#task-sheet textarea')!;
        box.setSelectionRange(5, 5);
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', ' every cent');
        return !box.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      });
      assert.equal(prevented, true, 'the box handled the paste');
      await page.until('the pasted text', () => document.querySelector<HTMLTextAreaElement>('#task-sheet textarea')!.value === 'Round every cent half up');
      assert.deepEqual(await page.eval(() => {
        const box = document.querySelector<HTMLTextAreaElement>('#task-sheet textarea')!;
        return [box.selectionStart, box === document.activeElement];
      }), [16, true]);
      await page.eval(() => document.execCommand('undo'));
      await page.until('undone', () => document.querySelector<HTMLTextAreaElement>('#task-sheet textarea')!.value === 'Round half up');
    },
  },
  {
    name: 'P5.2.32 a paste into New task\'s prompt and into Bug report\'s comment lands from the paste event itself, at the caret, though the browser\'s own insert comes up empty',
    async run({ page, mock }) {
      // A dispatched paste carries the text but has no insert of its own, as a paste whose clipboard read came back empty.
      const paste = (selector: string, at: number) => page.eval((s: string, i: number) => {
        const box = document.querySelector<HTMLTextAreaElement>(s)!;
        box.setSelectionRange(i, i);
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', ' every');
        return !box.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }, selector, at);
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await page.type('Fix cent');
      assert.equal(await paste('dialog#new-task textarea', 3), true, 'the prompt handled the paste');
      await page.until('the pasted prompt', () => document.querySelector<HTMLTextAreaElement>('dialog#new-task textarea')!.value === 'Fix every cent');
      assert.equal(await page.eval(() => document.querySelector<HTMLTextAreaElement>('dialog#new-task textarea')!.selectionStart), 9);
      await page.key('Escape');
      await page.until('New task to close', () => !document.querySelector('#new-task[open]'));

      await page.key('b');
      await page.until('Bug report, its comment focused', () => document.activeElement === document.querySelector('#bug-report textarea'));
      await page.type('Lost paste');
      assert.equal(await paste('#bug-report textarea', 4), true, 'the comment handled the paste');
      await page.until('the pasted comment', () => document.querySelector<HTMLTextAreaElement>('#bug-report textarea')!.value === 'Lost every paste');
    },
  },
  {
    name: 'P4.19 Bug report: B opens it from the Wall and Esc closes it unfiled; the top bar\'s Bug from a reply box keeps that box as the page it reports, and Enter uploads the recorder\'s report and starts a Pitwall task with the comment word for word',
    async run({ page, mock, shot }) {
      const open = () => !!document.querySelector('#bug-report:modal') && document.activeElement === document.querySelector('#bug-report textarea');
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await page.key('b');
      await page.until('Bug report, its comment focused', open);
      await page.until('the dialog to settle', settled);
      await shot('bug-report');
      await page.key('Escape');
      await page.until('Bug report to close', () => !document.querySelector('#bug-report[open]'));

      await page.click('[data-tile][data-session="s-invoice"] a');
      await page.until('the sheet of s-invoice', sheetOpen);
      await page.click('#task-sheet textarea');
      await page.type('Round');
      await page.eval(() => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', ' half up');
        document.querySelector('#task-sheet textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      });
      await page.click('[data-bug-report]');
      await page.until('Bug report, its comment focused', open);
      const comment = 'The paste ```landed``` twice';
      await page.type(comment);
      await page.key('Enter', { shift: true });
      await page.type('and `Z` did nothing');
      await page.key('Enter');
      const [created] = await logged(mock, 'the task', (e) => e.method === 'POST' && e.path === '/api/worktrees');
      const [uploaded] = await logged(mock, 'the report', (e) => e.method === 'POST' && e.path === '/api/uploads');
      assert.equal(created.status, 200);
      assert.equal(created.body.repoId, 3);
      assert.match(created.body.name, /^bug-\d{10}$/);
      assert.ok(created.body.prompt.includes(`\`\`\`\`\n${comment}\nand \`Z\` did nothing\n\`\`\`\``), created.body.prompt);
      assert.match(created.body.prompt, /\/bug-\d{10}\.json \(JSON\)/);
      assert.ok(uploaded.at <= created.at);
      const report = JSON.parse(uploaded.raw!);
      assert.equal(report.comment, `${comment}\nand \`Z\` did nothing`);
      const types = new Set(report.events.map((e: unknown[]) => e[1]));
      for (const t of ['load', 'focusin', 'keydown', 'beforeinput', 'input', 'paste', 'route', 'ux', 'bug-report-open', 'bug-report']) assert.ok(types.has(t), `the report records ${t}`);
      assert.match(report.snapshot.active, /^textarea#\d+ draft=s-invoice/);
      assert.deepEqual(report.snapshot.boxes.map((b: { focused: boolean; value: string }) => [b.focused, b.value]), [[true, 'Round half up']]);
      assert.match(report.snapshot.url, /\/s\/s-invoice/);
      assert.match(report.snapshot.text, /Fix invoice PDF rounding/);
      assert.match((await page.until('the toast', toastsOf, 'info'))[0].text, /^Filed the bug: a task reproduces it, fixes it and delivers the fix/);
      assert.equal(await page.eval(() => document.activeElement === document.querySelector('#task-sheet textarea')), true, 'focus went back to the box');
    },
  },
  {
    name: 'P4.20 Bug report with Pitwall out of reach: the report, the comment and the prompt it would have started are saved as a download, and an error toast says where',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.eval(() => {
        const marks = window as unknown as { e2eFetch: typeof fetch; e2eSaved: Promise<{ name: string; text: string }> };
        marks.e2eFetch = fetch;
        window.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
        marks.e2eSaved = new Promise((resolve) => {
          HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
            if (this.download) void marks.e2eFetch(this.href).then((r) => r.text()).then((text) => resolve({ name: this.download, text }));
          };
        });
      });
      await page.key('b');
      await page.until('Bug report', () => document.activeElement === document.querySelector('#bug-report textarea'));
      await page.type('The card never came back');
      await page.key('Enter');
      const saved = await page.eval(() => (window as unknown as { e2eSaved: Promise<{ name: string; text: string }> }).e2eSaved);
      assert.match(saved.name, /^bug-\d{10}\.json$/);
      const report = JSON.parse(saved.text);
      assert.equal(report.comment, 'The card never came back');
      assert.match(report.error, /could not be reached/);
      assert.ok(report.prompt.includes('```\nThe card never came back\n```'));
      assert.ok(report.prompt.includes(`this file (${saved.name} in Downloads)`));
      assert.ok(report.events.length > 0);
      const [error] = await page.until('the error toast', toastsOf, 'error');
      assert.match(error.text, new RegExp(`saved to Downloads as ${saved.name.replace('.', '\\.')}`));
      assert.equal((await mock.log()).some((e) => e.path === '/api/worktrees' || e.path === '/api/uploads'), false);
    },
  },
  {
    name: 'P5.2.23 Terminal posts a send held on its session at once, before it asks for the terminal',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.key('v');
      await page.until('the Wall', tiles);
      await page.click('[data-tile][data-session="s-cart"] button[aria-label="Session actions"]');
      await page.click(':popover-open button', 'Terminal');
      const opened = Date.now();
      const [focus] = await logged(mock, 'the terminal request', (e) => e.action === 'focus');
      const sent = await actions(mock);
      assert.deepEqual(sent.map((e) => [e.action, e.sessionId, e.status]), [['accept-advice', 's-cart', 204], ['focus', 's-cart', 204]]);
      assert.ok(sent[0].at - opened < 1000 && focus.at - opened < 3000, `posted ${sent[0].at - opened} ms and focused ${focus.at - opened} ms after Terminal`);
    },
  },
  {
    name: 'P5.2.24 Enter in a menu\'s own answer, with every question answered, holds answer-menu with that answer',
    clock: 'fast',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.key('ArrowRight');
      await ready(page, 's-hooks');
      await page.click('[data-card] input[aria-label="Your own answer: Backoff"]');
      await page.type('Every 10 min, 6 tries');
      await page.key('Enter');
      await page.until('s-group at the front', frontIs, 's-group');
      assert.match((await page.until('the undo toast', toastsOf, 'undo'))[0].text, /^Sending: “Backoff: Every 10 min, 6 tries · Give up: Email the account owner, Disable the endpoint”/);
      const [sent] = await logged(mock, 'the menu answer', (e) => e.action === 'answer-menu', POSTED_MS);
      assert.deepEqual([sent.status, sent.body], [204, {
        toolUseId: 'toolu_01Hooks', answers: [{ labels: [], other: 'Every 10 min, 6 tries' }, { labels: ['Email the account owner', 'Disable the endpoint'], other: '' }],
      }]);
    },
  },
  {
    name: 'P5.2.25 a reload loses nothing: the draft in a card\'s reply box, its attachment and the frozen choice come back',
    scenario: 'freeze',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await mock.post('/mock/advice', { id: 's-cart', state: 'done', choice: 'Ask the shopper', confidence: 71 });
      await page.until('the late second opinion on option 3', () => !!document.querySelector('[data-card] [data-option="3"]')?.parentElement?.innerText.includes("Second opinion's pick · 71%"));
      await page.until('the guard it restarted to end', unguarded);
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('only if stock allows');
      await page.eval(pastePng, '[data-card] textarea');
      await page.until('the picture uploaded', () => !!document.querySelector('[data-card] [data-state="ready"]'));
      await page.goto(`${mock.url}/`);
      await page.until('the card of s-cart', frontIs, 's-cart');
      const kept = await page.until('the reply box', replyIn, '[data-card]');
      assert.deepEqual({ ...kept, focused: undefined }, { value: 'only if stock allows', files: ['ready shot.png'], focused: undefined });
      const frozen = await page.eval(() => [...document.querySelectorAll('[data-card] [data-frozen] [data-option]')].map((o) => (o as HTMLElement).dataset.option));
      assert.deepEqual([frozen, (await page.eval(card))!.primary], [['1'], 'Send “Merge both carts” + your note']);
      await page.until('the card to settle', still);
      await shot('queue-after-reload');
    },
  },
  {
    name: 'P5.2.26 narrow window: with a send held, the queue has no sideways scroll, and both its primary and the undo toast stay in reach',
    narrow: true,
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.until('the primary in reach', reachable, '[data-primary]', '');
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.until('the undo toast in reach', reachable, '[data-toast][data-kind="undo"]', 'Sending');
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await page.until('the next primary in reach', reachable, '[data-primary]', '');
      await shot('narrow-held');
    },
  },
  {
    name: 'P5.2.n16 commands skip the early check: /compact held on s-cart goes out although a new question replaced the card\'s decision meanwhile',
    clock: 'fast',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('/compact');
      await page.until('the command list', () => [...document.querySelectorAll('[data-card] [role="option"] code')].some((c) => c.textContent === '/compact'));
      await page.key('Enter');
      await page.until('the undo toast', toastsOf, 'undo');
      await mock.post('/mock/patch', { id: 's-cart', patch: { question: { toolUseId: 'toolu_02', title: 'Merge the carts for app logins too?', options: [{ label: 'Yes' }, { label: 'No' }] } } });
      // The card keeps its decision while focus is in its reply box.
      await page.click('[data-card] h1');
      await page.until('the new decision on the card', () => document.querySelector<HTMLElement>('[data-card]')?.dataset.key === 'q:toolu_02');
      const [sent] = await logged(mock, 'the command', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.status, sent.body], [204, { key: 'q:toolu_01Cart', text: '/compact' }]);
      assert.equal(await page.eval(toastsOf, 'error'), null);
    },
  },
  {
    name: 'P5.2.undo-sheet the toast\'s Undo takes back a message sent from a sheet over the queue: the text is back in its reply box, nothing goes out, and the card being read stays, with no word that anything stopped waiting',
    clock: 'fast',
    async run({ wait, page, mock }) {
      await openQueue(page, mock);
      await page.goto(`${mock.url}/s/s-invoice/overview`);
      await page.until('the sheet over the queue', () => !!document.querySelector('#task-sheet') && document.documentElement.dataset.view === 'queue');
      await page.click('#task-sheet textarea');
      await page.type('Also round the tax lines');
      await page.key('Enter');
      await page.until('the undo toast', toastsOf, 'undo');
      await page.click('[data-toast][data-kind="undo"] button', 'Undo');
      await page.until('the message back in the reply box', () => document.querySelector<HTMLTextAreaElement>('#task-sheet textarea')?.value === 'Also round the tax lines');
      await wait(1000);
      assert.deepEqual([await page.eval(toastsOf, 'info'), await page.eval(toastsOf, 'undo')], [null, null]);
      await page.click('#task-sheet button[aria-label^="Back to"]');
      await page.until('the card of s-cart', frontIs, 's-cart');
      await wait(HELD_MS - 1000);
      assert.deepEqual(await actions(mock), []);
    },
  },
  {
    name: 'P5.2.esc-undo Esc takes back a held send: an option sent from the card brings s-cart back, and a message sent from the sheet goes back into its empty reply box; nothing goes out',
    clock: 'fast',
    async run({ wait, page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.click('[data-card] [data-option="2"]');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.key('Escape');
      await page.until('s-cart back at the front', frontIs, 's-cart');

      await page.goto(`${mock.url}/s/s-invoice/overview`);
      await page.until('the sheet', () => !!document.querySelector('#task-sheet'));
      await page.click('#task-sheet textarea');
      await page.type('Also round the tax lines');
      await page.key('Enter');
      await page.until('the undo toast', toastsOf, 'undo');
      await page.key('Escape');
      await page.until('the message back in the reply box', () => document.querySelector<HTMLTextAreaElement>('#task-sheet textarea')?.value === 'Also round the tax lines');
      assert.equal(await page.eval(() => !!document.querySelector('#task-sheet')), true, 'the sheet stayed');
      await wait(HELD_MS);
      assert.deepEqual(await actions(mock), []);
    },
  },
  {
    name: 'P5.2.sending a held send shows its task as Sending, not Decide: on its Wall tile and on its page; Esc there takes it back and Decide returns',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.click('[data-card] [data-option="2"]');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.key('v');
      await page.until('the Wall', tiles);
      const held = await page.eval(() => {
        const t = document.querySelector<HTMLElement>('[data-tile][data-session="s-cart"]')!;
        return [t.dataset.attention, t.querySelector('header')?.textContent?.includes('Sending')];
      });
      assert.deepEqual(held, ['sending', true]);
      await shot('wall-sending');
      await page.click('[data-tile][data-session="s-cart"] p');
      await page.until('its page says Sending', () => document.querySelector('#task-sheet header [data-attention]')?.textContent === 'Sending');
      await page.key('Escape');
      await page.until('Decide again once Esc took the send back', () => document.querySelector('#task-sheet header [data-attention]')?.textContent === 'Decide');
      assert.deepEqual(await actions(mock), []);
    },
  },
];
