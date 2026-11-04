import assert from 'node:assert/strict';
import { sleep, until } from '../cdp.ts';
import { actions, card, frontIs, HELD_MS, openFromWall, openNewTask, openQueue, openSheetOf, pickerOpen, pickRepo, ready, sheetOpen, still, tiles, toastsOf, wholeFile, type Check } from '../helpers.ts';

export const dialogs: Check[] = [
  {
    name: 'P4.esc-layers Esc over one file of the diff closes what is on top first: Keys, the ⋯ menu and the delete dialog each close and leave the file on its own; then Esc goes back to all files, and then closes the sheet',
    async run({ page, mock }) {
      await openFromWall(page, mock, 's-invoice');
      await page.key('3');
      await page.until('the file tree', () => document.querySelectorAll('nav[aria-label="Changed files"] a').length === 12);
      await page.click('nav[aria-label="Changed files"] a[data-explain="server/git.ts"]');
      await page.until('server/git.ts whole', wholeFile, 'server/git.ts');
      const layers = () => ({
        keys: !!document.querySelector('dialog#keys[open]'),
        menu: !!document.querySelector('[popover="auto"]:popover-open'),
        delete: !!document.querySelector('dialog#delete-worktree[open]'),
        sheet: !!document.querySelector('#task-sheet'),
        files: document.querySelectorAll('section[data-file]').length,
      });
      const escape = async (what: string, selector: string, open: () => Promise<void>) => {
        await open();
        await page.until(what, (s: string) => !!document.querySelector(s), selector);
        await page.key('Escape');
        await page.until(`${what} to close`, (s: string) => !document.querySelector(s), selector);
        await sleep(150);
        assert.deepEqual(await page.eval(layers), { keys: false, menu: false, delete: false, sheet: true, files: 1 }, what);
        assert.equal(await page.eval(wholeFile, 'server/git.ts'), true, `Esc on ${what} let go of the one file`);
      };
      await escape('Keys', 'dialog#keys[open]', () => page.key('?'));
      await escape('the ⋯ menu', '[popover="auto"]:popover-open', () => page.click('#task-sheet button[aria-label="Session actions"]'));
      await escape('the delete dialog', 'dialog#delete-worktree[open]', async () => {
        await page.click('#task-sheet button[aria-label="Session actions"]');
        await page.click(':popover-open button', 'Clear task');
      });
      await page.key('Escape');
      await page.until('all files again', () => document.querySelectorAll('section[data-file]').length === 12);
      assert.equal(await page.eval(sheetOpen), true, 'Esc in one file closed the sheet');
      await page.key('Escape');
      await page.until('the sheet to close', () => !document.querySelector('#task-sheet') && location.pathname === '/wall');
    },
  },
  {
    name: 'P4.esc-tooltip Esc with the pointer on the held send\'s toast, its tooltip showing, takes the send back and nothing goes out; with nothing held, Esc on a tooltip only dismisses it, and the next Esc leaves the Wall',
    async run({ page, mock }) {
      const tip = () => !!document.querySelector('#tooltip:popover-open');
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.hover('[data-toast][data-kind="undo"] [data-explain]');
      await page.until('the toast\'s tooltip', tip);
      await page.key('Escape');
      await page.until('s-cart back at the front', frontIs, 's-cart');
      assert.equal(await page.eval(toastsOf, 'undo'), null, 'the undo toast stayed');
      await page.until('the tooltip gone', () => !document.querySelector('#tooltip:popover-open'));
      await sleep(HELD_MS);
      assert.deepEqual(await actions(mock), [], 'the send went out');

      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await page.hover('[data-window]');
      await page.until('the usage\'s tooltip', tip);
      await page.key('Escape');
      await page.until('the tooltip gone', () => !document.querySelector('#tooltip:popover-open'));
      await sleep(150);
      assert.equal(await page.eval(() => location.pathname), '/wall', 'the Esc on the tooltip left the Wall');
      await page.key('Escape');
      await page.until('the queue', () => location.pathname === '/');
    },
  },
  {
    name: 'P4.esc-diff over one file of the diff, Esc takes back a send held from the reply box and keeps the file, and Esc in the rename field only cancels the rename; the next Esc goes back to all files, and the reply box has the message back',
    async run({ page, mock }) {
      // The page's clock runs slow, so the hold outlasts the steps to the file.
      await page.fastClock(0.4);
      await openFromWall(page, mock, 's-invoice');
      await page.click('#task-sheet textarea');
      await page.type('Also round the tax lines');
      await page.key('Enter');
      await page.until('the undo toast', toastsOf, 'undo');
      await page.click('#task-sheet [role="tab"]', 'Diff');
      await page.until('the file tree', () => document.querySelectorAll('nav[aria-label="Changed files"] a').length === 12);
      await page.click('nav[aria-label="Changed files"] a[data-explain="server/git.ts"]');
      await page.until('server/git.ts whole', wholeFile, 'server/git.ts');
      assert.ok(await page.eval(toastsOf, 'undo'), 'the hold ran out before the file opened');
      await page.key('Escape');
      await page.until('the undo toast gone', () => !document.querySelector('[data-toast][data-kind="undo"]'));
      await sleep(150);
      assert.deepEqual([await page.eval(sheetOpen), await page.eval(wholeFile, 'server/git.ts')], [true, true], 'the Esc that took the send back left the file');

      await page.click('#task-sheet h2 button');
      await page.until('the rename field', () => document.activeElement?.getAttribute('aria-label') === 'Task name');
      await page.type(' X');
      await page.key('Escape');
      await page.until('the title back', () => document.querySelector('#task-sheet h2')?.textContent === 'Fix invoice PDF rounding');
      await sleep(150);
      assert.deepEqual([await page.eval(sheetOpen), await page.eval(wholeFile, 'server/git.ts')], [true, true], 'the Esc in the rename field left the file');

      await page.key('Escape');
      await page.until('all files again', () => document.querySelectorAll('section[data-file]').length === 12);
      await page.click('#task-sheet [role="tab"]', 'Overview');
      await page.until('the message back in the reply box', () => document.querySelector<HTMLTextAreaElement>('#task-sheet textarea')?.value === 'Also round the tax lines');
      assert.deepEqual(await actions(mock), [], 'the send went out');
    },
  },
  {
    name: 'P4.close-in-place a sheet loaded in a tab after another page of the board closes in place: the page does not load again, and it says the task is gone',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the card', card);
      await page.goto(`${mock.url}/s/s-nope/overview`);
      await page.until('the sheet to close', () => !document.querySelector('#task-sheet') && location.pathname === '/');
      assert.deepEqual(await page.until('the toast', toastsOf, 'info'), [{ kind: 'info', text: 'That task is gone.', inSheet: false, hit: true }]);
      assert.deepEqual(await page.eval(() => ({
        loaded: new URL(performance.getEntriesByType('navigation')[0].name).pathname,
        at: window.navigation.currentEntry?.index,
        entries: window.navigation.entries().map((e) => new URL(e.url!).pathname),
      })), { loaded: '/s/s-nope/overview', at: 1, entries: ['/', '/'] });
    },
  },
  {
    name: 'P4.branches-once New task reads a repository\'s branch list once per opening: Current checkout does not ask again, a change of repository asks once, and opening New task again asks again',
    async run({ page, mock }) {
      const reads = async (repo: number) => (await mock.log()).filter((e) => e.method === 'GET' && e.path === `/api/repos/${repo}/branches`).length;
      const rows = (host: string) => [...document.querySelectorAll(`${host} [aria-label="Branches"] code`)].map((c) => c.textContent);
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await pickRepo(page, 'storefront');
      await page.click('dialog#new-task label', 'Current checkout');
      await page.until('the storefront branches', (host: string) => [...document.querySelectorAll(`${host} [aria-label="Branches"] code`)].some((c) => c.textContent === 'guest-cart-merge'), '#new-task');
      await sleep(300);
      assert.equal(await reads(1), 1);
      await pickRepo(page, 'billing');
      await page.until('the billing-api branches', (host: string) => [...document.querySelectorAll(`${host} [aria-label="Branches"] code`)].some((c) => c.textContent === 'webhook-retries'), '#new-task');
      await sleep(300);
      assert.deepEqual([await reads(1), await reads(2)], [1, 1]);
      assert.ok((await page.eval(rows, '#new-task')).includes('webhook-retries'));
      await page.key('Escape');
      await page.until('New task to close', () => !document.querySelector('#new-task[open]'));
      await openNewTask(page);
      await until('billing-api read again', async () => (await reads(2)) === 2);
      await sleep(300);
      assert.deepEqual([await reads(1), await reads(2)], [1, 2]);
    },
  },
  {
    name: 'P4.repo-filter New task\'s repository picker lists folders of repositories first, then repositories, by name, and filters by typing: by name or path, arrows and Enter pick, a letter on the closed button opens it already filtered, and no match says so',
    async run({ page, mock, shot }) {
      const picker = '#new-task [data-repo-picker]';
      const shown = (picker: string) => [...document.querySelectorAll(`${picker} [role="option"]`)].map((o) => o.querySelector('strong')?.textContent);
      const picked = () => document.querySelector('#new-task button[aria-haspopup="listbox"] strong')?.textContent;
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await page.click('dialog#new-task button[aria-haspopup="listbox"]');
      await page.until('the filter focused', (picker: string) => document.activeElement === document.querySelector(`${picker} input`), picker);
      assert.deepEqual(await page.eval(shown, picker), ['code', 'billing-api', 'docs-site', 'pitwall', 'storefront']);
      await page.type('code/');
      await page.until('the repositories under ~/code', (picker: string) => document.querySelectorAll(`${picker} [role="option"]`).length === 3, picker);
      await page.key('ArrowDown');
      await shot('new-task-repo-filter');
      await page.key('Enter');
      await page.until('docs-site picked', () => document.querySelector('#new-task button[aria-haspopup="listbox"] strong')?.textContent === 'docs-site');
      assert.equal(await page.eval(() => document.activeElement === document.querySelector('#new-task button[aria-haspopup="listbox"]')), true, 'focus went back to the button');
      assert.equal(await page.eval(() => !!document.querySelector('#new-task:modal')), true, 'Enter kept the dialog');
      assert.equal((await mock.log()).some((e) => e.method === 'POST' && e.path === '/api/worktrees'), false, 'Enter created nothing');

      await page.key('P');
      await page.until('the picker filtered by the letter', (picker: string) =>
        !!document.querySelector(`${picker}:popover-open`) && document.querySelector<HTMLInputElement>(`${picker} input`)?.value === 'P', picker);
      await page.type('ITWALL');
      await page.until('pitwall alone', (picker: string) => document.querySelectorAll(`${picker} [role="option"]`).length === 1, picker);
      await page.key('Enter');
      await page.until('pitwall picked', () => document.querySelector('#new-task button[aria-haspopup="listbox"] strong')?.textContent === 'pitwall');

      await page.click('dialog#new-task button[aria-haspopup="listbox"]');
      await page.until('the filter, empty again', (picker: string) => document.querySelector<HTMLInputElement>(`${picker} input`)?.value === '' &&
        document.querySelectorAll(`${picker} [role="option"]`).length === 5, picker);
      await page.type('nothing-like-it');
      await page.until('the empty note', (picker: string) => document.querySelector(`${picker} p`)?.textContent === 'No repository matches “nothing-like-it”', picker);
      await page.key('Enter');
      await page.key('Escape');
      await page.until('the picker to close', (picker: string) => !document.querySelector(`${picker}:popover-open`), picker);
      assert.deepEqual([await page.eval(picked), await page.eval(() => !!document.querySelector('#new-task:modal'))], ['pitwall', true]);
      await page.click('dialog#new-task button[aria-haspopup="listbox"]');
      await page.until('the picker', (picker: string) => !!document.querySelector(`${picker}:popover-open`), picker);
      await page.click(`${picker} [role="option"]`, 'billing-api');
      await page.until('billing-api picked by a click', () => document.querySelector('#new-task button[aria-haspopup="listbox"] strong')?.textContent === 'billing-api');
    },
  },
  {
    name: 'P4.repo-keys New task by keyboard alone: Tab goes round inside the dialog, from its last field to the repository button and back with Shift+Tab; Tab in the repository filter takes the highlighted one and moves on to the mode, Shift+Tab closes the list on the button',
    async run({ page, mock }) {
      const picker = '#new-task [data-repo-picker]';
      const button = '#new-task button[aria-haspopup="listbox"]';
      const focused = (selector: string) => document.activeElement === document.querySelector(selector);
      const picked = () => document.querySelector('#new-task button[aria-haspopup="listbox"] strong')?.textContent;
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await page.eval(() => [...document.querySelectorAll<HTMLSelectElement>('dialog#new-task select')].at(-1)!.focus());
      await page.key('Tab');
      await page.until('the repository button, after the last field', focused, button);
      await page.key('Tab', { shift: true });
      await page.until('the last field again', () => document.activeElement === [...document.querySelectorAll('dialog#new-task select')].at(-1));
      await page.key('Tab');
      await page.until('the repository button', focused, button);

      await page.key('b');
      await page.until('the picker filtered by the letter', (picker: string) => document.querySelector<HTMLInputElement>(`${picker}:popover-open input`)?.value === 'b', picker);
      await page.type('illing');
      await page.key('Tab');
      await page.until('billing-api picked, the list closed and focus on the mode', (picker: string) => !document.querySelector(`${picker}:popover-open`) &&
        document.querySelector('#new-task button[aria-haspopup="listbox"] strong')?.textContent === 'billing-api' &&
        document.activeElement === document.querySelector('dialog#new-task input[type="radio"]:checked'), picker);

      await page.key('Tab', { shift: true });
      await page.until('the repository button', focused, button);
      await page.key('ArrowDown');
      await page.until('the picker, its filter focused', (picker: string) => document.activeElement === document.querySelector(`${picker}:popover-open input`), picker);
      await page.key('ArrowDown');
      await page.key('Tab', { shift: true });
      await page.until('the list closed on the button', (picker: string) => !document.querySelector(`${picker}:popover-open`) &&
        document.activeElement === document.querySelector('#new-task button[aria-haspopup="listbox"]'), picker);
      assert.equal(await page.eval(picked), 'billing-api', 'Shift+Tab picked nothing');
      assert.equal(await page.eval(() => !!document.querySelector('#new-task:modal')), true);
      assert.equal((await mock.log()).some((e) => e.method === 'POST' && e.path === '/api/worktrees'), false, 'nothing was created');
    },
  },
  {
    name: 'P4.branch-filter New task\'s branch list stays closed until a click, ↓ or typing; 43+ branches scroll inside it and leave the dialog its size; typing filters, arrows and Enter pick, Esc closes only the list, and no match says so',
    async run({ page, mock, shot }) {
      const list = '#new-task [data-branch-picker]';
      const field = '#new-task [data-branch-field] input';
      const open = (list: string) => !!document.querySelector(`${list}:popover-open`);
      const shown = (list: string) => [...document.querySelectorAll(`${list} [role="option"] code`)].map((c) => c.textContent);
      const dialogHeight = () => Math.round(document.querySelector('dialog#new-task')!.getBoundingClientRect().height);
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await pickRepo(page, 'storefront');
      await page.click('dialog#new-task label', 'Current checkout');
      await page.until('the branches', (list: string) => document.querySelectorAll(`${list} [role="option"]`).length > 40, list);
      await page.until('the dialog to settle', still);
      const before = await page.eval(dialogHeight);
      assert.equal(await page.eval(open, list), false, 'closed until asked');
      await page.eval((field: string) => document.querySelector<HTMLInputElement>(field)!.focus(), field);
      await sleep(200);
      assert.equal(await page.eval(open, list), false, 'focus alone does not open it');

      await page.key('ArrowDown');
      await page.until('the list', open, list);
      const box = await page.eval((list: string) => {
        const el = document.querySelector(list)!;
        const r = el.getBoundingClientRect();
        return { scrolls: el.scrollHeight > el.clientHeight, inView: r.top >= 0 && r.bottom <= innerHeight, page: document.scrollingElement!.scrollHeight <= innerHeight };
      }, list);
      assert.deepEqual(box, { scrolls: true, inView: true, page: true });
      assert.ok(Math.abs((await page.eval(dialogHeight)) - before) <= 1, 'the dialog kept its size');
      await shot('new-task-branch-list');

      await page.type('kcl-1561');
      await page.until('ten matches', (list: string) => document.querySelectorAll(`${list} [role="option"]`).length === 10, list);
      assert.deepEqual((await page.eval(shown, list)).slice(0, 2), ['feature/kcl-15610', 'feature/kcl-15611']);
      await page.key('ArrowDown');
      await page.key('Enter');
      await page.until('the list to close', (list: string) => !document.querySelector(`${list}:popover-open`), list);
      assert.equal(await page.eval((field: string) => document.querySelector<HTMLInputElement>(field)!.value, field), 'feature/kcl-15611');
      assert.equal(await page.eval(() => !!document.querySelector('#new-task:modal')), true, 'Enter kept the dialog');
      assert.equal((await mock.log()).some((e) => e.method === 'POST' && e.path === '/api/worktrees'), false, 'Enter created nothing');

      await page.type('x');
      await page.until('the empty note', (list: string) => document.querySelector(`${list}:popover-open p`)?.textContent === 'No branch matches “feature/kcl-15611x”', list);
      await page.key('Escape');
      await page.until('the list to close', (list: string) => !document.querySelector(`${list}:popover-open`), list);
      assert.equal(await page.eval(() => !!document.querySelector('#new-task:modal')), true, 'Esc kept the dialog');
      await page.key('Escape');
      await page.until('the dialog to close', () => !document.querySelector('#new-task:modal'));
    },
  },
  {
    name: 'P4.ime Enter and Esc that an input method takes while it composes leave the rename field, New task\'s repository filter and its branch list as they are',
    async run({ page, mock }) {
      // The keydown a key gives while an input method composes, which the method takes for its own.
      const composing = (key: string) => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, isComposing: true, bubbles: true, cancelable: true }));
      await openSheetOf(page, mock, 's-reviews');
      await page.click('#task-sheet h2 button');
      await page.until('the rename field', () => document.activeElement?.getAttribute('aria-label') === 'Task name');
      await page.type(' X');
      await page.eval(composing, 'Enter');
      await page.eval(composing, 'Escape');
      await sleep(150);
      assert.equal(await page.eval(() => document.activeElement?.getAttribute('aria-label')), 'Task name', 'a composing key ended the rename');
      await page.key('Escape');
      await page.until('the title back', () => document.querySelector('#task-sheet h2')?.textContent === 'Lazy-load product reviews');

      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await page.click('dialog#new-task button[aria-haspopup="listbox"]');
      await page.until('the picker, its filter focused', () => document.activeElement === document.querySelector('#new-task [data-repo-picker] input'));
      await page.type('storefront');
      await page.eval(composing, 'Enter');
      await sleep(150);
      assert.equal(await page.eval(pickerOpen), true, 'a composing Enter picked the repository');
      await page.key('Enter');
      await page.until('the picker to close', () => !document.querySelector('#new-task [data-repo-picker]:popover-open'));

      const list = '#new-task [data-branch-picker]';
      const open = (list: string) => !!document.querySelector(`${list}:popover-open`);
      await page.click('dialog#new-task label', 'Current checkout');
      await page.until('the branches', (list: string) => document.querySelectorAll(`${list} [role="option"]`).length > 40, list);
      await page.eval(() => document.querySelector<HTMLInputElement>('#new-task [data-branch-field] input')!.focus());
      await page.key('ArrowDown');
      await page.until('the list', open, list);
      await page.type('kcl-1561');
      await page.until('ten matches', (list: string) => document.querySelectorAll(`${list} [role="option"]`).length === 10, list);
      await page.eval(composing, 'Enter');
      await page.eval(composing, 'Escape');
      await sleep(150);
      assert.deepEqual([await page.eval(open, list), await page.eval(() => document.querySelector<HTMLInputElement>('#new-task [data-branch-field] input')!.value)], [true, 'kcl-1561'], 'a composing key picked a branch or closed the list');
      await page.key('Escape');
      await page.until('the list to close', (list: string) => !document.querySelector(`${list}:popover-open`), list);
    },
  },
  {
    name: 'P4.delete-stays-closed a delete dialog closed just as its loss check comes back stays closed',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      // The loss check's answer waits until the check lets it through.
      await page.eval(() => {
        const w = window as unknown as { fetch: typeof fetch; e2eRelease: () => void };
        const real = w.fetch.bind(w);
        w.e2eRelease = () => {};
        w.fetch = (input, init) => {
          const response = real(input, init);
          if (!String(input).endsWith('/delete-worktree') || init?.method !== 'GET') return response;
          return new Promise((resolve) => (w.e2eRelease = () => resolve(response)));
        };
      });
      await page.click('[data-tile][data-session="s-invoice"] button[aria-label="Session actions"]');
      await page.click(':popover-open button', 'Clear task');
      await page.until('the loss check under way', () => !!document.querySelector('dialog#delete-worktree[open]')?.textContent?.includes('Checking'));
      // Closed the moment the answer is drawn, before the effects of that render run.
      await page.eval(() => {
        const dialog = document.querySelector<HTMLDialogElement>('dialog#delete-worktree')!;
        const drawn = new MutationObserver(() => {
          if (dialog.textContent?.includes('Checking')) return;
          drawn.disconnect();
          dialog.close();
        });
        drawn.observe(dialog, { subtree: true, childList: true, characterData: true });
        (window as unknown as { e2eRelease: () => void }).e2eRelease();
      });
      await sleep(400);
      assert.equal(await page.eval(() => !!document.querySelector('dialog#delete-worktree[open]')), false, 'the dialog opened again');
    },
  },
  {
    name: 'S1.ui-entry-sticky an entry /mock/ui-entry names is named again by every later push (none on --legacy) and to every socket that opens later, until {src: null} or a scenario load clears it',
    async run({ page, mock }) {
      const { legacy } = await mock.get('/mock');
      type Sockets = Record<string, { uiEntry?: string | null; sessions: { id: string; title: string | null }[] }[]>;
      const openSocket = (name: string) => {
        const w = window as unknown as { e2eSockets?: Sockets };
        const messages: Sockets[string] = [];
        (w.e2eSockets ??= {})[name] = messages;
        new WebSocket(`ws://${location.host}/ws/events`).onmessage = (e) => messages.push(JSON.parse(e.data));
      };
      // Once the socket has had `n` messages: whether each names an entry, which one, and the title of s-reviews.
      const heardOn = (name: string, n: number) => {
        const messages = (window as unknown as { e2eSockets?: Sockets }).e2eSockets?.[name] ?? [];
        return messages.length >= n && messages.map((m) => ({ carries: 'uiEntry' in m, uiEntry: m.uiEntry ?? null, title: m.sessions.find((s) => s.id === 's-reviews')?.title ?? null }));
      };
      const heard = (name: string, n: number) => page.until(`socket ${name} to get ${n} messages`, heardOn, name, n);
      const open = async (name: string) => {
        await page.eval(openSocket, name);
        await heard(name, 1);
      };

      // Not the board, which would reload into the entry named.
      await page.goto(`${mock.url}/mock`);
      await open('a');
      const [{ uiEntry: entry, title }] = await heard('a', 1);
      assert.match(entry ?? '', /^\/assets\/index-[\w-]+\.js$/);
      const src = '/assets/index-sticky.js';
      const [once, twice] = [`${title}, patched`, `${title}, patched again`];
      await mock.post('/mock/ui-entry', { src });
      await mock.post('/mock/patch', { id: 's-reviews', patch: { title: once } });
      await open('b');
      await mock.post('/mock/ui-entry', { src: null });
      await mock.post('/mock/patch', { id: 's-reviews', patch: { title: twice } });
      await open('c');
      await mock.post('/mock/ui-entry', { src });
      await mock.post('/mock/scenario/queue');
      await open('d');

      const told = (uiEntry: string | null, title: string | null) => ({ carries: true, uiEntry, title });
      const pushed = (uiEntry: string | null, title: string | null) => (legacy ? { carries: false, uiEntry: null, title } : told(uiEntry, title));
      assert.deepEqual(await heard('a', 7), [
        told(entry, title), told(src, title), pushed(src, once), told(entry, once), pushed(entry, twice), told(src, twice), pushed(entry, title),
      ]);
      assert.deepEqual(await heard('b', 5), [told(src, once), told(entry, once), pushed(entry, twice), told(src, twice), pushed(entry, title)]);
      assert.deepEqual(await heard('c', 3), [told(entry, twice), told(src, twice), pushed(entry, title)]);
      assert.deepEqual(await heard('d', 1), [told(entry, title)]);
    },
  },
  {
    name: 'S1.new-task a New task with a prompt is working right after it is made, with no step yet (Thinking on --legacy) and its clock from that moment',
    async run({ mock }) {
      const { legacy } = await mock.get('/mock');
      const before = Date.now();
      const { sessionId } = await mock.post('/api/worktrees', { repoId: 1, name: 'starting-step', prompt: 'Make the cart test stop flaking' });
      const after = Date.now();
      const s = (await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === sessionId);
      assert.deepEqual([s.status, s.activity.step], ['working', legacy ? 'Thinking' : null]);
      assert.ok(s.activity.since >= before && s.activity.since <= after, `the clock runs from ${s.activity.since}, not from the New task at ${before}–${after}`);
    },
  },
];
