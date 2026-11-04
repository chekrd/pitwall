import assert from 'node:assert/strict';
import { KEYS } from '../../../web/src/keys.ts';
import { until } from '../cdp.ts';
import { card, logged, matches, openFromWall, openNewTask, openQueue, pastePng, pickRepo, pillAt, reachable, reloadState, settled, sheetOpen, sidewaysScroll, tiles, toastsOf, type Check, type Probe } from '../helpers.ts';

export const newTask: Check[] = [
  {
    name: 'P4.10 New task opened on the Wall: a space typed in the name or branch becomes a hyphen; Model and Effort name what Claude Code would pick by itself; Enter in the prompt creates from the prompt, repository and name and opens the new sheet; a refused name shows inline and keeps the fields; the model and effort picked go with it and show on its Overview; Current checkout hides Branch and Worktree path, starts on the repository\'s default branch and lists the server\'s branches by name in a list under the field, with the hint',
    expectedErrors: [/status of 400/],
    async run({ page, mock, shot }) {
      const submit = () => document.querySelector('dialog#new-task textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await page.type('Fix the login redirect');
      await pickRepo(page, 'storefront');
      await page.click('dialog#new-task input[placeholder="fix-login-redirect"]');
      await page.type('fix login');
      assert.equal(await page.eval(() => document.querySelector<HTMLInputElement>('dialog#new-task input[placeholder="fix-login-redirect"]')!.value), 'fix-login', 'a space in the name became a hyphen');
      await page.click('dialog#new-task input[placeholder="fix-login"]');
      await page.type('fix login');
      assert.equal(await page.eval(() => document.querySelector<HTMLInputElement>('dialog#new-task input[placeholder="fix-login"]')!.value), 'fix-login', 'a space in the branch became a hyphen');
      assert.deepEqual(await page.until('the real defaults', () => {
        const shown = [...document.querySelectorAll('dialog#new-task select')].map((s) => s.querySelector('option')?.textContent);
        return !shown.includes('Default') && shown;
      }), ['Opus 5.5 (1M context)', 'Medium']);
      await page.eval(() => {
        for (const [label, value] of [['Model', 'sonnet'], ['Effort', 'xhigh']]) {
          const select = [...document.querySelectorAll('dialog#new-task label')].find((l) => l.querySelector('span')?.textContent === label)!.querySelector('select')!;
          select.value = value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      await shot('new-task-wall');
      await page.eval(submit);
      const [created] = await logged(mock, 'the new task', (e) => e.method === 'POST' && e.path === '/api/worktrees');
      const { repoId, name, prompt, existingBranch, model, effort } = created.body;
      assert.deepEqual({ repoId, name, prompt, existingBranch, model, effort, status: created.status }, {
        repoId: 1, name: 'fix-login', prompt: 'Fix the login redirect', existingBranch: false, model: 'sonnet', effort: 'xhigh', status: 200,
      });
      await page.until('its sheet', () => !!document.querySelector('#task-sheet') && /^\/s\/[^/]+\/overview$/.test(location.pathname) &&
        document.querySelector('#task-sheet h2')?.textContent === 'fix-login');
      const facts = await page.until('its facts', () => {
        const dl = document.querySelector('#task-sheet dl');
        return dl && Object.fromEntries([...dl.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
      });
      assert.equal(facts.Model, 'Sonnet 5.5 @ extra high');
      await page.click('#task-sheet button[aria-label^="Back to"]');
      await page.until('the Wall', () => !document.querySelector('#task-sheet') && location.pathname === '/wall');
      await openNewTask(page);
      assert.equal(await page.eval(() => document.querySelector<HTMLTextAreaElement>('dialog#new-task textarea')!.value), '', 'the form kept the created task');
      await page.click('dialog#new-task input[placeholder="fix-login-redirect"]');
      await page.type('half-typed');
      await page.key('Escape');
      await page.until('New task to close', () => !document.querySelector('#new-task[open]'));
      await openNewTask(page);
      assert.equal(await page.eval(() => document.querySelector<HTMLInputElement>('dialog#new-task input[placeholder="fix-login-redirect"]')!.value), '', 'the name starts empty each time');
      await page.type('Try a refused name');
      await page.click('dialog#new-task input[placeholder="fix-login-redirect"]');
      await page.type('fail');
      await page.eval(submit);
      const error = await page.until('the inline error', () => document.querySelector('dialog#new-task [role="alert"]')?.textContent);
      assert.match(error, /cannot be created here/);
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('dialog#new-task textarea, dialog#new-task input:not([data-repo-picker] *, [type="radio"], [type="file"])')].map((f) => f.value)), ['fail', 'Try a refused name', '', '']);

      const extra = () => [...document.querySelectorAll('dialog#new-task label > span')].map((c) => c.textContent).filter((t) => t === 'Branch' || t === 'Worktree path');
      assert.deepEqual(await page.eval(extra), ['Branch', 'Worktree path'], 'New worktree shows its branch and path');
      await page.click('dialog#new-task label', 'Current checkout');
      await page.until('only the branch picker', (want: string) => JSON.stringify([...document.querySelectorAll('dialog#new-task label > span')].map((c) => c.textContent).filter((t) => t === 'Branch' || t === 'Worktree path')) === want, JSON.stringify(['Branch']));
      await logged(mock, 'the branches', (e) => e.method === 'GET' && e.path === '/api/repos/1/branches');
      assert.equal(await page.eval(() => document.querySelector<HTMLInputElement>('#new-task [data-branch-field] input')!.value), 'main', 'the repository\'s default branch, its base without origin/');
      await page.click('#new-task [data-branch-field] input');
      const rows = await page.until('the branch list', () => {
        const list = [...document.querySelectorAll('#new-task [data-branch-picker]:popover-open [role="option"]')].map((b) => [b.querySelector('code')?.textContent, b.querySelector('span')?.textContent ?? '']);
        return list.length && list;
      });
      for (const row of [['main', 'main checkout'], ['guest-cart-merge', 'own worktree'], ['release/2026.10', '']]) assert.deepEqual(rows.find((c) => c[0] === row[0]), row);
      const names = rows.map((r) => r[0]);
      assert.deepEqual(names, names.toSorted((a, b) => a!.localeCompare(b!, undefined, { numeric: true, sensitivity: 'base' })), 'by name');
      const hint = () => document.querySelector('dialog#new-task [data-hint]')?.textContent;
      assert.equal(await page.eval(hint), 'Starts Claude in ~/code/storefront, where it is checked out.');
      await page.click('#new-task [data-branch-picker] [role="option"]', 'guest-cart-merge');
      await page.until('the list to close', () => !document.querySelector('#new-task [data-branch-picker]:popover-open'));
      await page.until('the hint for a branch with its own worktree', () =>
        document.querySelector('dialog#new-task [data-hint]')?.textContent === 'Starts Claude in ~/code/worktrees/guest-cart-merge/storefront, where it is checked out.');
      await shot('new-task-existing-branch');
    },
  },
  {
    name: 'P4.10.files New task\'s prompt takes files as a reply box does: a pasted screenshot and a dropped file show as chips, Create waits while one uploads, the task starts with their paths, and the next New task starts without them; a chip can be taken off',
    async run({ page, mock, shot }) {
      const chips = () => [...document.querySelectorAll<HTMLElement>('dialog#new-task [data-state]')].map((f) => `${f.dataset.state} ${f.querySelector('button')?.getAttribute('aria-label')?.replace(/^Remove /, '')}`);
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await page.type('Fix what the screenshot shows');
      await pickRepo(page, 'storefront');
      await page.click('dialog#new-task input[placeholder="fix-login-redirect"]');
      await page.type('shot-fix');
      const waited = await page.eval(() => {
        const fetched = window.fetch;
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        (window as unknown as { release: () => void }).release = release;
        window.fetch = (input, init) => (String(input).includes('/api/uploads') ? held.then(() => fetched(input, init)) : fetched(input, init));
        const data = new DataTransfer();
        data.items.add(new File(['tail -f'], 'server.log', { type: 'text/plain' }));
        document.querySelector('dialog#new-task form')!.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
        return new Promise<boolean>((r) => requestAnimationFrame(() => r(document.querySelector<HTMLButtonElement>('dialog#new-task button[type="submit"]')!.disabled)));
      });
      assert.equal(waited, true, 'Create waits while a file uploads');
      await page.eval(() => (window as unknown as { release: () => void }).release());
      await page.eval(pastePng, 'dialog#new-task textarea');
      await page.until('both chips uploaded', () => document.querySelectorAll('dialog#new-task [data-state="ready"]').length === 2);
      assert.deepEqual(await page.eval(chips), ['ready server.log', 'ready shot.png']);
      assert.equal(await page.eval(() => document.querySelector<HTMLTextAreaElement>('dialog#new-task textarea')!.value), 'Fix what the screenshot shows', 'the paste left the prompt as typed');
      assert.equal(await page.eval(() => document.querySelector<HTMLButtonElement>('dialog#new-task button[type="submit"]')!.disabled), false);
      await shot('new-task-files');
      await page.eval(() => document.querySelector('dialog#new-task textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      const [created] = await logged(mock, 'the new task', (e) => e.method === 'POST' && e.path === '/api/worktrees');
      assert.equal(created.status, 200);
      assert.equal(created.body.prompt, 'Fix what the screenshot shows');
      assert.deepEqual((created.body.files as string[]).map((f) => f.split('/').at(-1)), ['server.log', 'shot.png']);
      await page.until('its sheet', () => document.querySelector('#task-sheet h2')?.textContent === 'shot-fix');
      await page.click('#task-sheet button[aria-label^="Back to"]');
      await page.until('the Wall', () => !document.querySelector('#task-sheet') && location.pathname === '/wall');
      await openNewTask(page);
      assert.deepEqual(await page.eval(chips), [], 'the next New task starts without the files');
      await page.eval(pastePng, 'dialog#new-task textarea');
      await page.until('the chip', () => !!document.querySelector('dialog#new-task [data-state="ready"]'));
      await page.click('dialog#new-task button[aria-label="Remove shot.png"]');
      await page.until('the chip gone, the prompt focused', () => !document.querySelector('dialog#new-task [data-state]') && document.activeElement === document.querySelector('dialog#new-task textarea'));
    },
  },
  {
    name: 'P4.10.branch New worktree\'s hint follows the branch it will use, the Branch field or else the name, as it is typed: a new one branches from the base, one only on origin is tracked, a local one is reused, and one checked out already says where',
    async run({ page, mock, shot }) {
      const hint = (want: string) => document.querySelector('dialog#new-task [data-hint]')?.textContent === want;
      const erase = async (n: number) => {
        for (let i = 0; i < n; i++) await page.key('Backspace');
      };
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await pickRepo(page, 'storefront');
      await logged(mock, 'the branches', (e) => e.method === 'GET' && e.path === '/api/repos/1/branches');
      await page.click('dialog#new-task input[placeholder="fix-login-redirect"]');
      await page.type('fix login');
      await page.until('a new branch from the base', hint, 'Branches from origin/main and starts Claude there. Runs pnpm install there first.');
      await page.click('dialog#new-task input[placeholder="fix-login"]');
      await page.type('renovate/vite-8');
      await page.until('the branch on origin, tracked', hint, 'Tracks origin/renovate/vite-8 in a new branch and starts Claude there. Runs pnpm install there first.');
      await shot('new-task-tracks-origin');
      await erase('renovate/vite-8'.length);
      await page.type('spike/edge-cache');
      await page.until('the local branch, reused', hint, 'Reuses the local branch spike/edge-cache and starts Claude there. Runs pnpm install there first.');
      await erase('spike/edge-cache'.length);
      await page.type('guest-cart-merge');
      await page.until('the branch checked out already', hint, 'guest-cart-merge is already checked out in ~/code/worktrees/guest-cart-merge/storefront.');
      await erase('guest-cart-merge'.length);
      await page.until('the name\'s branch again', hint, 'Branches from origin/main and starts Claude there. Runs pnpm install there first.');
      await page.click('dialog#new-task input[placeholder="fix-login-redirect"]');
      await erase('fix-login'.length);
      await page.type('renovate/vite-8');
      await page.until('the name on origin, tracked', hint, 'Tracks origin/renovate/vite-8 in a new branch and starts Claude there. Runs pnpm install there first.');
    },
  },
  {
    name: 'P4.11 Repos: Add, a folder\'s ×, Rescan, Settings Save, Remove worktree and Continue send their requests, and Continue opens the sheet',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await page.click('[data-repos]');
      await page.until('Repos', () => !!document.querySelector('dialog#workspace:modal'));
      assert.equal(await page.eval(() => document.activeElement?.id), 'workspace');
      const home = await mock.home();
      await page.until('the sheet to settle', settled);
      await shot('repos');
      const request = async (what: string, method: string, path: string) => (await logged(mock, what, (e) => e.method === method && e.path === path)).at(-1)!;

      await page.click('#workspace input[aria-label="Repository or folder"]');
      await page.type('~/code/payments');
      await page.click('#workspace button[type="submit"]', 'Add');
      assert.deepEqual((await request('Add', 'POST', '/api/repos')).body, { path: `${home}/code/payments` });
      assert.equal(await page.eval((path) => document.querySelector(`#workspace [data-worktree="${path}"] code`)?.textContent, `${home}/code/worktrees/invoice-rounding/billing-api`),
        '~/code/worktrees/invoice-rounding/billing-api', 'a path in the home folder shows from ~');
      await page.click('#workspace button[aria-label="Stop scanning ~/code"]');
      assert.deepEqual((await request('the folder\'s ×', 'DELETE', '/api/roots')).body, { path: `${home}/code` });
      await page.click('#workspace button', 'Rescan');
      await request('Rescan', 'POST', '/api/rescan');
      await page.click('#workspace button', 'Settings');
      await page.click('#workspace input[name="baseBranch"]');
      await page.type('origin/develop');
      await page.click('#workspace button[type="submit"]', 'Save');
      assert.equal((await request('Save', 'PATCH', '/api/repos/1')).body.baseBranch, 'origin/develop');
      const row = `#workspace [data-worktree="${home}/code/worktrees/lazy-reviews/storefront"]`;
      await page.click(`${row} button`, 'Remove');
      await page.click(`${row} button[type="submit"]`, 'Remove worktree');
      assert.deepEqual((await request('Remove worktree', 'DELETE', '/api/worktrees')).body, {
        repoId: 1, path: `${home}/code/worktrees/lazy-reviews/storefront`, deleteBranch: false, force: false,
      });
      await page.click(`#workspace [data-worktree="${home}/code/storefront"] button`, 'Continue');
      assert.deepEqual((await request('Continue', 'POST', '/api/sessions')).body, { repoId: 1, worktree: `${home}/code/storefront`, continueId: 'c-sf-1' });
      await page.until('the continued conversation\'s sheet', () =>
        location.pathname === '/s/c-sf-1/overview' && !!document.querySelector('#task-sheet') && !document.querySelector('dialog#workspace[open]'));
    },
  },
  {
    name: 'P4.11s Repos: Add on a folder that holds repositories scans it, which then shows under Scanned folders, and adds no repository',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await page.click('[data-repos]');
      await page.until('Repos', () => !!document.querySelector('dialog#workspace:modal'));
      const before = (await mock.get('/api/state')).repos.length;
      await page.click('#workspace input[aria-label="Repository or folder"]');
      await page.type('~/git');
      await page.click('#workspace button[type="submit"]', 'Add');
      const [added] = await logged(mock, 'Add', (e) => e.method === 'POST' && e.path === '/api/repos');
      assert.deepEqual(added.body, { path: `${await mock.home()}/git` });
      await page.until('the folder among the scanned ones', () => !!document.querySelector('#workspace button[aria-label="Stop scanning ~/git"]'));
      assert.equal((await mock.get('/api/state')).repos.length, before);
    },
  },
  {
    name: 'P4.priority the ⋯ menu sets the task\'s own priority: Auto at first, High and Low send it and show it pressed, Auto clears it; the card names it beside its kind, and a low task still waits in the queue',
    async run({ page, mock, shot }) {
      const pressed = () => document.querySelector(':popover-open [data-priority] [aria-pressed="true"]')?.textContent;
      const pick = async (label: string, priority: string | null) => {
        await page.click(':popover-open [data-priority] button', label);
        await page.until(`${label} pressed`, (want: string) => document.querySelector(':popover-open [data-priority] [aria-pressed="true"]')?.textContent === want, label);
        const sent = await logged(mock, `the priority ${label}`, (e) => e.action === 'priority' && e.body.priority === priority);
        assert.deepEqual([sent.at(-1)!.sessionId, sent.at(-1)!.status], ['s-cart', 204]);
      };
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await page.click('[data-tile][data-session="s-cart"] button[aria-label="Session actions"]');
      assert.equal(await page.until('the priority row', pressed), 'Auto');
      await pick('High', 'high');
      await shot('session-menu-priority');
      await pick('Auto', null);
      await pick('Low', 'low');
      await page.key('Escape');
      await page.until('the menu to close', () => !document.querySelector(':popover-open'));
      await openQueue(page, mock);
      await page.until('the Low priority chip on the card', () => document.querySelector('[data-card]')?.textContent?.includes('Low priority'));
    },
  },
  {
    name: 'P4.12 toasts inside the open sheet: an error from its ⋯ menu shows in the sheet and takes the point at its middle; an archive\'s Undo and a toast\'s × both work there',
    expectedErrors: [/boom/, /status of 400/],
    async run({ page, mock, shot }) {
      await openFromWall(page, mock, 's-invoice');
      await mock.post('/mock/fail', { error: 'boom' });
      await page.click('#task-sheet button[aria-label="Session actions"]');
      await page.click(':popover-open button', 'Archive');
      assert.deepEqual(await page.until('the error toast', toastsOf, 'error'), [{ kind: 'error', text: 'boom', inSheet: false, hit: true }]);

      await page.click('#task-sheet button[aria-label="Session actions"]');
      await page.click(':popover-open button', 'Archive');
      await logged(mock, 'the archive', (e) => e.action === 'archive' && e.body.archived === true && e.status === 204);
      assert.deepEqual(await page.until('the undo toast', toastsOf, 'undo'), [{ kind: 'undo', text: 'Archived Fix invoice PDF rounding\nUndo\n⌘Z', inSheet: false, hit: true }]);
      await shot('toasts-in-sheet');
      await page.click('[data-toast][data-kind="undo"] button', 'Undo');
      const [unarchived] = await logged(mock, 'the undo', (e) => e.action === 'archive' && e.body.archived === false);
      assert.deepEqual([unarchived.sessionId, unarchived.status], ['s-invoice', 204]);
      await page.click('[data-toast][data-kind="error"] button[aria-label="Dismiss"]');
      await page.until('the toasts to go', () => !document.querySelector('[data-toast]'));
      assert.equal(await page.eval(sheetOpen), true);
    },
  },
  {
    name: 'P4.13 ? opens Keys with the rows of the KEYS table and Esc closes it; with the delete dialog open ? does nothing',
    async run({ holds, page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await page.key('?');
      const rows = await page.until('the Keys dialog', () =>
        document.querySelector<HTMLDialogElement>('dialog#keys')?.open && [...document.querySelectorAll('dialog#keys dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
      assert.deepEqual(rows, KEYS.map((r) => [r.keys, r.help]));
      assert.equal(await page.eval(() => document.activeElement?.id), 'keys');
      await page.until('the dialog to settle', settled);
      await shot('keys');
      await page.key('Escape');
      await page.until('Keys to close', () => !document.querySelector('dialog#keys[open]'));

      await page.click('[data-tile][data-session="s-invoice"] button[aria-label="Session actions"]');
      await page.click(':popover-open button', 'Clear task');
      await page.until('the delete dialog', () => !!document.querySelector('dialog#delete-worktree[open]'));
      await page.key('?');
      await holds('Keys to stay closed over the delete dialog', 300, () => page.eval(() => !document.querySelector('dialog#keys[open]') && !!document.querySelector('dialog#delete-worktree[open]')));
    },
  },
  {
    name: 'P4.14 a dropped connection: within 1.5 s the pill reads Reconnecting…, breathes and says since when, then Live again',
    expectedErrors: [/WebSocket/, /ERR_CONNECTION/, /ERR_EMPTY_RESPONSE/],
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the live pill', () => document.querySelector('[data-link="live"]') !== null);
      const start = Date.now();
      await mock.post('/mock/drop', { ms: 3000 });
      try {
        const down = await page.until('the pill to turn reconnecting', pillAt, 'reconnecting');
        assert.ok(Date.now() - start < 1500, `reconnecting after ${Date.now() - start} ms`);
        assert.deepEqual({ ...down, title: undefined }, { link: 'reconnecting', text: 'Reconnecting…', title: undefined, breathing: 'breathe' });
        assert.match(down.title, /^Lost the connection to Pitwall at .+; what you see may be out of date\. Answers you send wait and go out once it is back\.$/);
        await shot('reconnecting');
      } finally {
        await until('the drop to end', () => mock.get('/mock').then(() => true, () => false), 10_000);
      }
      const back = await until('the pill to turn live again', () => page.eval(pillAt, 'live'), 10_000);
      assert.deepEqual({ ...back, breathing: undefined }, { link: 'live', text: 'Live', title: '', breathing: undefined });
    },
  },
  {
    name: 'P4.16 narrow window: no sideways scroll on the Wall or in the sheet, which is full width; New task and the sheet\'s close stay in reach; the reload pill meets nothing else in the top bar and shows its whole text',
    narrow: true,
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await page.until('New task in reach', reachable, 'button[aria-label="New task"]', '');
      await shot('narrow-wall');

      // A build this tab already reloaded for is offered at once.
      const build = '/assets/index-narrow.js';
      await page.eval((build: string) => {
        const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')!.src;
        sessionStorage.setItem('pitwall:reloaded-for', `${entry} ${new URL(build, location.href).href}`);
      }, build);
      await mock.post('/mock/ui-entry', { src: build });
      await page.until('the reload pill', () => !!document.querySelector('[data-new-version]'));
      const bar = await page.eval(() => {
        const box = (s: string) => document.querySelector(s)?.getBoundingClientRect();
        const pill = document.querySelector<HTMLElement>('[data-new-version]')!;
        const at = pill.getBoundingClientRect();
        const meets = (b: DOMRect | undefined) => !!b && at.left < b.right && b.left < at.right && at.top < b.bottom && b.top < at.bottom;
        const others = ['[data-wordmark]', '[data-link]', '[data-meter]', '[data-repos]', 'nav[aria-label="View"]', 'button[aria-label="New task"]'];
        return { meets: others.filter((s) => meets(box(s))), cut: pill.scrollWidth > pill.clientWidth, inside: at.left >= 0 && at.right <= innerWidth };
      });
      assert.deepEqual(bar, { meets: [], cut: false, inside: true });
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await shot('narrow-reload-pill');
      await page.click('[data-tile][data-session="s-invoice"] a');
      await page.until('the sheet', sheetOpen);
      await page.until('the sheet to settle', settled);
      const sheet = await page.eval(() => {
        const r = document.querySelector('#task-sheet')!.getBoundingClientRect();
        return { left: Math.round(r.left), width: Math.round(r.width), innerWidth };
      });
      assert.deepEqual(sheet, { left: 0, width: sheet.innerWidth, innerWidth: sheet.innerWidth });
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await page.until('the sheet\'s close in reach', reachable, '#task-sheet button[aria-label^="Back to"]', '');
      await shot('narrow-sheet');
    },
  },
  {
    name: 'P4.17 the reload pill: a new build announced while the New task prompt has focus offers "New version · Reload" after 15 s with the link live; the page\'s own build clears it, another arms it again, and the pill itself reloads while the prompt keeps focus, noting the build it reloaded for',
    async run({ holds, page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await page.type('Fix the login redirect');
      await page.eval(() => void ((window as unknown as Probe).e2eMarker = true));
      const own = await page.eval(() => document.querySelector('script[type="module"][src]')!.getAttribute('src')!);
      const offered = async (build: string) => {
        const at = Date.now();
        await mock.post('/mock/ui-entry', { src: build });
        const before = { pill: null, link: 'live', marker: true, prompt: 'Fix the login redirect', typing: true };
        await holds('the page as it was, with no pill yet', 1000, async () => matches(await page.eval(reloadState, null), before));
        const state = await until('the reload pill', () => page.eval(reloadState, 'pill'), 20_000);
        assert.ok(Date.now() - at >= 14_500, `offered after ${Date.now() - at} ms`);
        assert.deepEqual(state, { pill: 'New version · Reload', link: 'live', marker: true, prompt: 'Fix the login redirect', typing: true });
      };
      await offered('/assets/index-next1.js');
      await shot('reload-pill');
      await mock.post('/mock/ui-entry', { src: own });
      await page.until('the pill to go', () => !document.querySelector('[data-new-version]'));
      await offered('/assets/index-next2.js');
      // Clicked from the page, so the prompt keeps focus: the gate stays shut, and only the pill can reload.
      const typing = await page.eval(() => {
        setTimeout(() => document.querySelector<HTMLButtonElement>('[data-new-version]')!.click());
        return document.activeElement === document.querySelector('dialog#new-task textarea');
      });
      assert.equal(typing, true, 'the prompt lost focus before the pill was clicked');
      await page.until('the page to reload', () => (window as unknown as Probe).e2eMarker === undefined && document.readyState === 'complete');
      await page.until('the prompt kept through the reload', () => document.querySelector<HTMLTextAreaElement>('dialog#new-task textarea')?.value === 'Fix the login redirect');
      assert.equal(await page.eval(() => {
        const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')!.src;
        return sessionStorage.getItem('pitwall:reloaded-for') === `${entry} ${new URL('/assets/index-next2.js', location.href).href}`;
      }), true, 'the pill did not note the build it reloaded for');
    },
  },
  {
    name: 'P4.17 the reload pill hides while the board reconnects',
    expectedErrors: [/WebSocket/, /ERR_CONNECTION/, /ERR_EMPTY_RESPONSE/],
    async run({ page, mock }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await page.type('Fix the login redirect');
      await mock.post('/mock/ui-entry', { src: '/assets/index-next1.js' });
      await until('the reload pill', () => page.eval(() => !!document.querySelector('[data-new-version]')), 20_000);
      await mock.post('/mock/drop', { ms: 3000 });
      try {
        const dropped = await page.until('the board to reconnect', reloadState, 'reconnecting');
        assert.deepEqual([dropped.link, dropped.pill], ['reconnecting', null]);
      } finally {
        await until('the drop to end', () => mock.get('/mock').then(() => true, () => false), 10_000);
      }
      await until('the link to come back', () => page.eval(() => document.querySelector('[data-link="live"]') !== null), 10_000);
    },
  },
  {
    name: 'P4.18 New task keeps its fields: a prompt typed in it on the Wall and closed is there when N opens it over the queue, on the repository, and a reload keeps it',
    async run({ page, mock, shot }) {
      const dialogPrompt = () => {
        const d = document.querySelector<HTMLDialogElement>('dialog#new-task');
        const prompt = d?.querySelector('textarea');
        return d?.open && prompt && { value: prompt.value, repositoryFocused: document.activeElement === d.querySelector('button[aria-haspopup="listbox"]') };
      };
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await page.type('Typed on the Wall');
      await page.key('Escape');
      await page.until('the dialog to close', () => !document.querySelector('dialog#new-task[open]'));
      await page.click('nav[aria-label="View"] a', 'Queue');
      await page.until('the queue', () => location.pathname === '/');
      await page.key('n');
      assert.deepEqual(await page.until('the New task dialog', dialogPrompt), { value: 'Typed on the Wall', repositoryFocused: true });
      await page.until('the dialog to settle', settled);
      await shot('new-task-dialog');
      await page.key('Escape');
      await page.until('the dialog to close', () => !document.querySelector('dialog#new-task[open]'));
      await page.goto(`${mock.url}/`);
      await page.until('the card', card);
      await page.key('n');
      assert.deepEqual(await page.until('the New task dialog after a reload', dialogPrompt), { value: 'Typed on the Wall', repositoryFocused: true });
    },
  },
];
