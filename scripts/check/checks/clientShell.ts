import assert from 'node:assert/strict';
import { sleep, until } from '../cdp.ts';
import { actions, cartNotSent, decisionOf, HELD_MS, logged, matches, noDecision, openDecision, openNewTask, openSheetOf, pastePng, pngOnDisk, POSTED_MS, ready, replyIn, replyOnCart, sent, settled, sheetOpen, tiles, toastsOf, type Check } from '../helpers.ts';

const toWall = '#task-sheet header button[aria-label="Back to the Wall"]';

// The open task's page still shows `id`'s decision, at its Overview.
const stillOn = (id: string) => location.pathname === `/s/${id}/overview` && !!document.querySelector(`#task-sheet[data-session="${id}"] [data-decision]`);

export const clientShell: Check[] = [
  {
    name: 'client-1 the paperclip keeps the keys in the decision\'s reply box: after a file is picked or one is removed the field has focus and takes 2 and e as text, and with focus on the paperclip itself 2 and x do nothing',
    clock: 'fast',
    async run({ holds, page, mock }) {
      const png = pngOnDisk();
      try {
        await openDecision(page, mock);
        await page.key('w');
        await page.until('the reply box, focused', () => document.activeElement?.matches('[data-decision] textarea'));
        await page.type('keep the quantities');
        await page.chooseFiles('[data-decision] input[type="file"]', [png.file]);
        await page.until('the picked file, uploaded', () => !!document.querySelector('[data-decision] [data-state="ready"]'));
        assert.equal((await page.eval(replyIn, '[data-decision]'))?.focused, true, 'focus stayed on the paperclip');
        for (const key of [' ', '2', ' ', 'e']) await page.key(key);
        assert.deepEqual(await page.eval(replyIn, '[data-decision]'), { value: 'keep the quantities 2 e', files: ['ready shot.png'], focused: true });

        await page.click('[data-decision] button[aria-label="Remove shot.png"]');
        assert.equal((await page.eval(replyIn, '[data-decision]'))?.focused, true, 'focus fell to the page');
        await page.key('2');
        assert.deepEqual(await page.eval(replyIn, '[data-decision]'), { value: 'keep the quantities 2 e2', files: [], focused: true });

        await page.key('Tab');
        await page.until('the paperclip, focused', () => document.activeElement?.matches('[data-decision] input[type="file"]'));
        await page.key('2');
        await page.key('x');
        await holds('the keys on the paperclip to hold no send nor switch tabs', 300, async () => (await page.eval(toastsOf, 'undo')) === null && (await page.eval(stillOn, 's-cart')));
        await holds('nothing to go out', HELD_MS, async () => !(await actions(mock)).length);
      } finally {
        png.remove();
      }
    },
  },
  {
    name: 'shell-1 a click beside an open ⋯ menu only closes it: on a decision\'s page it presses no option, on the Wall it opens no other task, and on a task page it runs no Terminal',
    async run({ holds, page, mock }) {
      const menuShown = () => !!document.querySelector('[popover="auto"]:popover-open');
      // A point on the first visible match whose text has `text`, clear of the open menu, where that match takes the hit.
      const besideMenu = (selector: string, text: string) => {
        const el = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.checkVisibility() && (e.textContent ?? '').includes(text));
        const menu = document.querySelector('[popover="auto"]:popover-open')?.getBoundingClientRect();
        if (!el || !menu) return null;
        const r = el.getBoundingClientRect();
        for (let x = r.left + 8; x < r.right; x += 8) {
          const y = r.top + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          if ((x < menu.left || x > menu.right || y < menu.top || y > menu.bottom) && hit && el.contains(hit)) return { x, y };
        }
        return null;
      };
      const clickBeside = async (selector: string, text = '') => {
        await page.until('the ⋯ menu', menuShown);
        const at = await page.until(`${selector} beside the menu`, besideMenu, selector, text);
        await page.pointAt(at.x, at.y, true);
        await page.until('the menu to close', () => !document.querySelector('[popover="auto"]:popover-open'));
      };
      const where = () => [location.pathname, !!document.querySelector('#task-sheet')];

      await openDecision(page, mock);
      await page.click('#task-sheet header button[aria-label="Session actions"]');
      await clickBeside('[data-decision] [data-option="1"]');
      const clicked = Date.now();
      await holds('the click to press no option', 400, async () => (await page.eval(toastsOf, 'undo')) === null && (await page.eval(stillOn, 's-cart')));

      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      await page.click('[data-tile][data-session="s-invoice"] button[aria-label="Session actions"]');
      await clickBeside('[data-tile][data-session="s-search"] p');
      await holds('the click to open no task', 400, async () => matches(await page.eval(where), ['/', false]));

      await openSheetOf(page, mock, 's-astro');
      await page.until('the sheet to settle', settled);
      await page.click('#task-sheet header button[aria-label="Session actions"]');
      await clickBeside('#task-sheet [role="tabpanel"] button', 'Terminal');
      await holds('the click to leave the task as it is', 1000, async () => matches(await page.eval(where), ['/s/s-astro/overview', true]));
      await holds('nothing to go out', Math.max(0, HELD_MS - (Date.now() - clicked)), async () => !(await actions(mock)).length);
    },
  },
  {
    name: 'client-2.landed a reload while a reply is held flushes it, and the page after the reload, seeing it answered, brings nothing back',
    async run({ holds, page, mock }) {
      await replyOnCart(page, mock, 'Merge them, but keep the account cart quantities');
      const pressed = Date.now();
      await page.goto(`${mock.url}/`);
      const [sent] = await logged(mock, 'the reply the reload flushed', (e) => e.action === 'answer');
      assert.deepEqual([sent.sessionId, sent.status, sent.body.text], ['s-cart', 204, 'Merge them, but keep the account cart quantities']);
      await page.until('the board', tiles);
      await holds('nothing to come back', Math.max(0, 9000 - (Date.now() - pressed)), async () => matches([
        await page.eval(toastsOf, 'error'), await page.eval(() => [sessionStorage.getItem('pitwall:sends'), sessionStorage.getItem('pitwall:drafts')]), (await actions(mock)).length,
      ], [null, ['[]', '[]'], 1]));
    },
  },
  {
    name: 'client-2.refused a reply held through a reload whose flushed post the server refuses comes back after the reload as Not sent, with its text in the reply box, and nothing posts again',
    expectedErrors: [/status of 400/],
    async run({ page, mock }) {
      await mock.post('/mock/fail', { error: 'this question is no longer open', code: 'stale' });
      await replyOnCart(page, mock, 'Merge them, but keep the account cart quantities');
      // The reload comes partway into the hold.
      await sleep(500);
      await page.goto(`${mock.url}/`);
      const [refused] = await logged(mock, 'the refused post', (e) => e.action === 'answer');
      assert.deepEqual([refused.sessionId, refused.status, refused.code], ['s-cart', 400, 'stale']);
      await cartNotSent(page, 'Merge them, but keep the account cart quantities');
      assert.equal((await actions(mock)).length, 1);
    },
  },
  {
    name: 'client-2.unreachable a reply waiting for an unreachable board through a reload comes back as Not sent once the board is back, with its text in the reply box, and never posts',
    expectedErrors: [/WebSocket/, /ERR_/],
    async run({ page, mock }) {
      await replyOnCart(page, mock, 'Merge them, but keep the account cart quantities');
      await mock.post('/mock/drop', { ms: 9000 });
      try {
        await until('the waiting toast', async () => (await page.eval(toastsOf, 'info'))?.find((t) => t.text.startsWith('Waiting for Pitwall')), 9000);
        await page.goto(`${mock.url}/`).catch(() => {});
      } finally {
        await until('the drop to end', () => mock.get('/mock').then(() => true, () => false), 15_000);
      }
      await page.goto(`${mock.url}/`);
      await cartNotSent(page, 'Merge them, but keep the account cart quantities');
      assert.deepEqual(await actions(mock), []);
    },
  },
  {
    name: 'client-2.freeze a reply waiting for an unreachable board when the page is frozen and resumes still goes out once the board is back',
    clock: 'fast',
    expectedErrors: [/WebSocket/, /ERR_/],
    async run({ holds, page, mock }) {
      await replyOnCart(page, mock, 'Merge them, but keep the account cart quantities');
      await mock.post('/mock/drop', { ms: 7000 });
      try {
        await until('the waiting toast', async () => (await page.eval(toastsOf, 'info'))?.find((t) => t.text.startsWith('Waiting for Pitwall')), 9000);
        await page.lifecycle('frozen');
        await sleep(300);
        await page.lifecycle('active');
      } finally {
        await until('the drop to end', () => mock.get('/mock').then(() => true, () => false), 15_000);
      }
      const [sent] = await logged(mock, 'the reply, once the board is back', (e) => e.action === 'answer', 10_000);
      assert.deepEqual([sent.sessionId, sent.status, sent.body.text], ['s-cart', 204, 'Merge them, but keep the account cart quantities']);
      await holds('the reply to go out once', 1000, async () => (await actions(mock)).length === 1);
    },
  },
  {
    name: 'shell-3 keys typed into New task\'s open repository picker over the Wall are the picker\'s: Esc closes only it, D, ? and Z do nothing, and a send held meanwhile still goes out',
    async run({ holds, page, mock }) {
      const openPicker = async () => {
        await page.click('dialog#new-task button[aria-haspopup="listbox"]');
        await page.until('the picker, its filter focused', () => !!document.querySelector('#new-task [data-repo-picker]:popover-open') &&
          document.activeElement === document.querySelector('#new-task [data-repo-picker] input'));
      };
      const where = () => ({ path: location.pathname, picker: !!document.querySelector('#new-task [data-repo-picker]:popover-open'), modal: !!document.querySelector('dialog:modal') });
      await openDecision(page, mock);
      await page.click('[data-decision] [data-option]', 'Keep the account cart');
      const pressed = Date.now();
      await page.until('the decision to go', noDecision, 's-cart');
      await page.click(toWall);
      await page.until('the Wall', () => location.pathname === '/' && document.querySelectorAll('[data-tile]').length > 0);
      await openNewTask(page);
      await openPicker();
      for (const key of ['d', '?', 'z']) {
        await page.key(key);
        await holds(`${key} to stay in the picker`, 200, async () => matches(await page.eval(where), { path: '/', picker: true, modal: true }));
      }
      assert.equal((await page.eval(toastsOf, 'undo'))?.length, 1, 'z took back the held send');
      await page.key('Escape');
      await page.until('the picker to close', () => !document.querySelector('#new-task [data-repo-picker]:popover-open'));
      await holds('Esc to close only the picker', 200, async () => matches(await page.eval(where), { path: '/', picker: false, modal: true }));
      const [sent] = await logged(mock, 'the held answer', (e) => e.action === 'answer', POSTED_MS - (Date.now() - pressed));
      assert.deepEqual([sent.sessionId, sent.body.choice, sent.status], ['s-cart', 'Keep the account cart', 204]);
    },
  },
  {
    name: 'client-3 an option pressed, or ⏎, while the decision\'s reply box still uploads its picture sends nothing and says so; once the picture is up the same option sends it along',
    clock: 'fast',
    async run({ holds, page, mock }) {
      await openDecision(page, mock);
      await page.eval(() => {
        const w = window as unknown as { e2eUploads: () => void };
        const up = new Promise<void>((done) => (w.e2eUploads = done));
        const fetched = window.fetch;
        window.fetch = (input, init) => ((input instanceof Request ? input.url : String(input)).includes('/api/uploads') ? up.then(() => fetched(input, init)) : fetched(input, init));
      });
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-decision] textarea'));
      await page.type('see the screenshot');
      await page.eval(pastePng, '[data-decision] textarea');
      await page.until('the picture, uploading', () => !!document.querySelector('[data-decision] [data-state="uploading"]'));
      await page.click('[data-decision] [data-option="2"]');
      await page.until('the word that nothing was sent', () =>
        document.querySelector('[data-decision] section[aria-label] [role="status"]')?.textContent === 'An attachment is still uploading; nothing was sent.');
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.key('Enter');
      await holds('an option or ⏎ to send nothing while the picture uploads', 300, async () => (await page.eval(toastsOf, 'undo')) === null && (await page.eval(stillOn, 's-cart')));
      await page.eval(() => (window as unknown as { e2eUploads: () => void }).e2eUploads());
      await page.until('the picture, up', () => !!document.querySelector('[data-decision] [data-state="ready"]'));
      await page.click('[data-decision] [data-option="2"]');
      await page.until('the decision to go', noDecision, 's-cart');
      const [sent] = await logged(mock, 'the answer', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.body.choice, sent.body.text, sent.body.files?.length], ['Keep the account cart', 'see the screenshot', 1]);
      assert.equal((await actions(mock)).length, 1);
    },
  },
  {
    name: 'client-4 Z pressed in the same moment as an answer takes back that answer, not the send before it, and an Undo takes its send back at once, before its decision comes back',
    clock: 'fast',
    async run({ holds, page, mock }) {
      await openDecision(page, mock);
      await page.key('Enter');
      await page.until('the decision to go', noDecision, 's-cart');
      await page.click('#task-sheet [data-next-after] button');
      await ready(page, 's-hooks');
      await page.key('d');
      await ready(page, 's-group');
      await page.eval(() => {
        document.querySelector<HTMLButtonElement>('[data-decision] [data-option="1"]')!.click();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', bubbles: true, cancelable: true }));
      });
      await page.until('s-group\'s decision back', decisionOf, 's-group');
      await logged(mock, 'the send', sent, POSTED_MS);
      const cartOnly = async () => matches((await actions(mock)).map((e) => [e.action, e.sessionId]), [['answer', 's-cart']]);
      await holds('the answer Z took back to stay back', HELD_MS, cartOnly);

      await ready(page, 's-group');
      await page.click('[data-decision] [data-option="1"]');
      await page.until('its toast', toastsOf, 'undo');
      const kept = await page.eval(() => {
        [...document.querySelectorAll<HTMLButtonElement>('[data-toast][data-kind="undo"] button')].find((b) => b.textContent?.startsWith('Undo'))!.click();
        return (JSON.parse(sessionStorage.getItem('pitwall:sends') ?? '[]') as { sessionId: string }[]).map((i) => i.sessionId);
      });
      assert.deepEqual(kept.filter((id) => id === 's-group'), [], 'the send was still held when its Undo had run');
      await page.until('s-group\'s decision back', decisionOf, 's-group');
      await holds('the send Undo took back to stay back', HELD_MS, cartOnly);
    },
  },
  {
    name: 'client-4.late-file a file that finishes uploading between a press and its hold stays in the reply box, as the send does not carry it',
    clock: 'fast',
    async run({ page, mock }) {
      await openDecision(page, mock);
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-decision] textarea'));
      await page.type('see the screenshot');
      await page.eval(() => {
        const fetched = window.fetch;
        window.fetch = (input, init) => ((input instanceof Request ? input.url : String(input)).includes('/api/uploads')
          ? Promise.resolve(new Response(JSON.stringify({ path: '/uploads/late/shot.png' }), { headers: { 'content-type': 'application/json' } }))
          : fetched(input, init));
        const section = document.querySelector('[data-decision] textarea')!.closest('section')!;
        document.querySelector<HTMLButtonElement>('[data-decision] [data-option="2"]')!.click();
        const data = new DataTransfer();
        data.items.add(new File(['png'], 'shot.png', { type: 'image/png' }));
        section.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
      });
      const [sent] = await logged(mock, 'the answer', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.body.choice, sent.body.text, sent.body.files], ['Keep the account cart', 'see the screenshot', undefined]);
      const drafts = await page.eval(() => JSON.parse(sessionStorage.getItem('pitwall:drafts') ?? '[]') as [string, { text: string; files: { path: string }[] }][]);
      assert.deepEqual(drafts, [['s-cart', { text: '', files: [{ name: 'shot.png', path: '/uploads/late/shot.png' }] }]]);
    },
  },
  {
    name: 'shell-4 Show on a Not sent toast over another task opens the refused task\'s page in place of it, its decision marked Not sent, so one step back still goes to the Wall',
    expectedErrors: [/status of 400/],
    async run({ page, mock }) {
      const history = () => ({
        entries: window.navigation.entries().map((e) => new URL(e.url!).pathname),
        index: window.navigation.currentEntry?.index,
      });
      await mock.post('/mock/fail', { error: 'this question is no longer open', code: 'stale' });
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      await page.click('[data-tile][data-session="s-cart"] p');
      await ready(page, 's-cart');
      await page.click('[data-decision] [data-option]', 'Keep the account cart');
      await page.until('the decision to go', noDecision, 's-cart');
      await page.click('#task-sheet [data-next-after] button');
      await page.until('the page of s-hooks', decisionOf, 's-hooks');
      await page.until('the Not sent toast over the task', () => !!document.querySelector('[data-toast][data-kind="error"] button'));
      await page.click('[data-toast][data-kind="error"] button', 'Show');
      await page.until('s-cart\'s decision, marked Not sent', () =>
        location.pathname === '/s/s-cart/overview' && document.querySelector('[data-decision] [data-not-sent]')?.textContent === 'Not sent: this question is no longer open');
      assert.deepEqual(await page.eval(history), { entries: ['/', '/s/s-cart/overview'], index: 1 });
      await page.click(toWall);
      await page.until('the Wall', () => location.pathname === '/' && !document.querySelector('#task-sheet'));
    },
  },
  {
    name: 'shell-5 a click in an artifact gives the frame focus, and once the pointer leaves it the task page has focus again, so 1 shows Overview and Esc goes back to the Wall',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/s/s-cart/artifacts`);
      await page.until('the sheet', sheetOpen);
      await page.until('the sheet to settle', settled);
      const frame = await page.until('the artifact', () => {
        const f = document.querySelector<HTMLIFrameElement>('#task-sheet iframe');
        const r = f?.getBoundingClientRect();
        return r && r.width > 100 && f!.contentWindow ? { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top } : null;
      });
      // The frame's sandbox keeps its document out of reach, so its load cannot be awaited.
      await sleep(300);
      await page.pointAt(frame.x, frame.y, true);
      await page.until('the frame, focused', () => document.activeElement?.tagName === 'IFRAME');
      await page.pointAt(frame.x, frame.top - 40);
      await page.until('the sheet, focused', () => document.activeElement?.id === 'task-sheet');
      await page.key('1');
      await page.until('Overview', () => location.pathname === '/s/s-cart/overview');
      await page.key('Escape');
      await page.until('the Wall', () => location.pathname === '/' && !document.querySelector('#task-sheet'));
    },
  },
  {
    name: 'shell-6 with reduced motion a double click on a toast\'s Undo brings the decision back and stays on its page, as the second click presses nothing that came under it',
    clock: 'fast',
    motion: 'reduce',
    async run({ holds, page, mock }) {
      await openDecision(page, mock);
      await page.click('[data-decision] [data-option]', 'Keep the account cart');
      await page.until('the decision to go', noDecision, 's-cart');
      const undo = await page.until('the toast\'s Undo', () => {
        const b = [...document.querySelectorAll<HTMLElement>('[data-toast][data-kind="undo"] button')].find((x) => x.textContent?.startsWith('Undo'));
        const r = b?.getBoundingClientRect();
        return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      });
      await page.pointAt(undo.x, undo.y, true);
      await sleep(110);
      await page.pointAt(undo.x, undo.y, true, 2);
      await page.until('the decision back', decisionOf, 's-cart');
      await holds('the page to stay', 400, () => page.eval(stillOn, 's-cart'));
      await holds('nothing to go out', HELD_MS, async () => !(await actions(mock)).length);
    },
  },
];
