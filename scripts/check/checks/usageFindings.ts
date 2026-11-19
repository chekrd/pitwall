import assert from 'node:assert/strict';
import { approveLoss, logged, menuItems, openFromWall, openNewTask, openQueue, openSheetOf, ready, tiles, whole, type Check } from '../helpers.ts';

export const usageFindings: Check[] = [
  {
    name: 'usage the top bar shows the 5-hour and weekly limits on the queue and the Wall, each with its share, its level, its reset time and a mark where an even pace would have it, the weekday too when it is not today; a new reading shows at once, a passed reset shows 0 % and no reading shows –',
    async run({ page, mock, shot }) {
      const usage = () => [...document.querySelectorAll<HTMLElement>('header [data-usage] [data-window]')].map((w) => ({
        window: w.dataset.window, text: w.innerText.replace(/\s+/g, ' ').trim(), level: w.dataset.level ?? null, title: w.dataset.explain ?? "",
      }));
      await openQueue(page, mock);
      const queue = await page.eval(usage);
      assert.deepEqual(queue.map((w) => ({ window: w.window, level: w.level })), [{ window: '5h', level: 'low' }, { window: '7d', level: 'mid' }]);
      assert.match(queue[0].text, /^5h 34% ↻ (?:\w+ )?\d\d:\d\d$/);
      assert.match(queue[1].text, /^7d 61% ↻ \w+ \d\d:\d\d$/);
      assert.match(queue[0].title, /^5-hour limit: 34% used, 2\d under an even pace of 5\d% · resets \d\d:\d\d · read at \d\d:\d\d$/);
      assert.match(queue[1].title, /^Weekly limit: 61% used, 4 over an even pace of 57% · resets \w+ \d\d:\d\d · read at \d\d:\d\d$/);
      const paces = await page.eval(() => [...document.querySelectorAll<HTMLElement>('header [data-usage] [data-pace]')].map((p) => {
        const track = p.parentElement!.getBoundingClientRect();
        const mark = p.getBoundingClientRect();
        return { pace: Number(p.dataset.pace), at: track.width ? Math.round(((mark.left + mark.width / 2 - track.left) / track.width) * 100) : null };
      }));
      assert.equal(paces.length, 2, 'each limit marks its even pace');
      const bars = await page.eval(() => innerWidth >= 1300);
      for (const p of paces) assert.ok(bars ? p.at !== null && Math.abs(p.at - p.pace) <= 3 : p.at === null, `the even pace mark sits at ${p.at}% of its bar, not ${p.pace}%`);
      assert.ok(paces[0].pace >= 55 && paces[0].pace <= 59 && paces[1].pace === 57, `even paces ${paces.map((p) => p.pace).join(", ")}`);
      assert.equal(await page.eval(whole, 'header [data-usage]'), true, 'the usage limits do not show whole');
      await shot('usage');

      await page.goto(`${mock.url}/wall`);
      await page.until('the Wall', () => !!document.querySelector('[data-tile]'));
      assert.deepEqual((await page.eval(usage)).map((w) => w.text.split(' ↻')[0]), ['5h 34%', '7d 61%']);

      const now = Date.now();
      await mock.post('/mock/usage', { usage: { fiveHour: { percent: 87.4, resetsAt: now - 1000 }, sevenDay: { percent: 92.6, resetsAt: now + 3_600_000 }, at: now } });
      const after = await page.until('the new reading', () => {
        const w = [...document.querySelectorAll<HTMLElement>('header [data-usage] [data-window]')];
        return w[1]?.innerText.includes('93%') ? w.map((x) => ({ text: x.innerText.replace(/\s+/g, ' ').trim(), level: x.dataset.level, title: x.dataset.explain ?? "" })) : null;
      });
      assert.deepEqual(after.map((w) => ({ text: w.text.split(' ↻')[0], level: w.level })), [{ text: '5h 0%', level: 'low' }, { text: '7d 93%', level: 'high' }]);
      assert.equal(after[0].text, '5h 0%', 'a passed reset still shows its time');
      assert.match(after[1].text, /^7d 93% ↻ (?:\w+ )?\d\d:\d\d$/);
      assert.match(after[0].title, /^5-hour limit: reset at \d\d:\d\d, with no reading since$/);
      assert.match(after[1].title, /^Weekly limit: 93% used, 6 under an even pace of 99% · resets /);
      assert.equal(await page.eval(() => document.querySelectorAll('header [data-usage] [data-pace]').length), 1, 'a passed reset marks no even pace');

      await mock.post('/mock/usage', { usage: null });
      await page.goto(`${mock.url}/wall`);
      await page.until('the Wall', () => !!document.querySelector('[data-tile]'));
      const none = await page.eval(usage);
      assert.deepEqual(none.map((w) => [w.text, w.level]), [['5h –', null], ['7d –', null]]);
      assert.match(none[0].title, /no reading yet/);
    },
  },
  {
    name: 'usage a status line copy without the 5-hour window, as Claude Code writes from a session whose last-seen 5-hour reset has passed, keeps the 5-hour reading the board had instead of showing –',
    async run({ page, mock }) {
      await openQueue(page, mock);
      const now = Math.floor(Date.now() / 1000);
      const shown = () => [...document.querySelectorAll<HTMLElement>('header [data-usage] [data-window]')].map((w) => w.innerText.replace(/\s+/g, ' ').trim().split(' ↻')[0]);
      await mock.post('/mock/status-line', { at: Date.now(), rate_limits: { five_hour: { used_percentage: 23, resets_at: now + 7200 }, seven_day: { used_percentage: 12, resets_at: now + 86_400 } } });
      await page.until('the full reading', () => document.querySelector<HTMLElement>('header [data-usage]')?.innerText.includes('23%') || null);
      await mock.post('/mock/status-line', { at: Date.now(), rate_limits: { seven_day: { used_percentage: 13, resets_at: now + 86_400 } } });
      await page.until('the weekly-only reading', () => document.querySelector<HTMLElement>('header [data-usage]')?.innerText.includes('13%') || null);
      assert.deepEqual(await page.eval(shown), ['5h 23%', '7d 13%']);
    },
  },
  {
    name: 'drift a banner says which Claude Code version changed which file Pitwall reads, Fix it opens New task on Pitwall with a prompt to update it, and the banner leaves when the drift is gone',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      assert.equal(await page.eval(() => !!document.querySelector('[data-drift]')), false, 'a banner shows without drift');
      await mock.post('/mock/drift', { drift: [{ problem: 'session files report an unknown status "thinking"', version: '9.9.9', at: Date.now() }] });
      const text = await page.until('the drift banner', () => document.querySelector<HTMLElement>('[data-drift]')?.innerText.replace(/\s+/g, ' ').trim() || null);
      assert.match(text, /^Claude Code 9\.9\.9 changed what Pitwall reads: session files report an unknown status "thinking"\./);
      await shot('drift');
      await page.click('[data-fix-drift]');
      const form = await page.until('New task with the fix, its repository focused', () => {
        const dialog = document.querySelector<HTMLDialogElement>('dialog#new-task');
        const prompt = dialog?.querySelector<HTMLTextAreaElement>('textarea');
        if (!dialog?.open || !prompt || document.activeElement !== dialog.querySelector('button[aria-haspopup="listbox"]')) return null;
        return {
          repo: dialog.querySelector<HTMLElement>('[data-ux="repository"] strong')?.innerText,
          worktree: dialog.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.parentElement?.innerText.trim(),
          name: dialog.querySelector<HTMLInputElement>('input[placeholder="fix-login-redirect"]')?.value,
          prompt: prompt.value,
        };
      });
      assert.equal(form.repo, 'pitwall');
      assert.equal(form.worktree, 'New worktree');
      assert.equal(form.name, 'claude-code-drift');
      assert.match(form.prompt, /Claude Code 9\.9\.9 changed a file it reads/);
      assert.match(form.prompt, /^- session files report an unknown status "thinking"$/m);
      await page.eval(() => document.querySelector<HTMLDialogElement>('dialog#new-task')!.close());
      await mock.post('/mock/drift', { drift: [] });
      await page.until('the banner gone', () => !document.querySelector('[data-drift]'));
    },
  },
  {
    name: 'usage.narrow the top bar shows both limits as shares with their reset times and without their bars, whole, beside the actions',
    narrow: true,
    async run({ page, mock }) {
      await openQueue(page, mock);
      const shown = await page.eval(() => [...document.querySelectorAll<HTMLElement>('header [data-usage] [data-window]')].map((w) => w.innerText.replace(/\s+/g, ' ').trim()));
      assert.deepEqual(shown.map((t) => t.split(' ↻')[0]), ['5h 34%', '7d 61%']);
      assert.ok(shown.every((t) => / ↻ /.test(t)), 'a reset time is missing');
      assert.equal(await page.eval(whole, 'header [data-usage]'), true, 'the usage limits do not show whole');
      assert.equal(await page.eval(() => document.scrollingElement!.scrollWidth <= innerWidth), true, 'the page scrolls sideways');
    },
  },
  {
    name: 'task-page a task opened from the Wall is a page of its own: it fills the window under the top bar, which still shows the usage limits, and the Wall under it is hidden and inert; Esc goes back to the Wall where it was scrolled to',
    scenario: 'volume',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      const id = await page.eval(() => {
        const tile = [...document.querySelectorAll<HTMLElement>('[data-tile][data-attention="working"]')].findLast((t) => !t.closest('details'));
        tile?.scrollIntoView({ block: 'center' });
        return tile?.dataset.session ?? null;
      });
      assert.ok(id, 'no working tile to open');
      const scrolled = await page.eval(() => document.querySelector('main')!.scrollTop);
      assert.ok(scrolled > 0, 'the Wall did not scroll');
      await page.click(`[data-tile][data-session="${id}"] a`);
      await page.until('the task page', () => location.pathname.startsWith('/s/') && !!document.querySelector('#task-sheet [role="tablist"]'));
      const box = await page.eval(() => {
        const r = document.querySelector('#task-sheet')!.getBoundingClientRect();
        const bar = document.querySelector('header')!.getBoundingClientRect();
        const view = document.querySelector<HTMLElement>('.view')!;
        return {
          top: Math.round(r.top) === Math.round(bar.bottom), left: r.left === 0, right: r.right === innerWidth, bottom: Math.round(r.bottom) === innerHeight,
          usage: !!document.querySelector('header [data-usage]')?.checkVisibility(), inert: view.inert, hidden: getComputedStyle(view.querySelector('main')!).visibility,
          focused: document.activeElement === document.querySelector('#task-sheet'),
        };
      });
      assert.deepEqual(box, { top: true, left: true, right: true, bottom: true, usage: true, inert: true, hidden: 'hidden', focused: true });
      assert.equal(await page.eval(whole, '#task-sheet button[aria-label="Back to the Wall"]'), true);
      await shot('task-page');
      await page.key('Escape');
      await page.until('the Wall again', () => location.pathname === '/wall' && !document.querySelector('#task-sheet'));
      assert.equal(await page.eval(() => document.querySelector('main')!.scrollTop), scrolled, 'the Wall lost its scroll');
    },
  },
  {
    name: 'task-page.queue the card\'s task name links to the task\'s page; the back button names the queue and brings the same card back',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      const link = await page.eval(() => document.querySelector<HTMLAnchorElement>('[data-card] [data-open-task]')?.getAttribute('href'));
      assert.equal(link, '/s/s-cart/overview');
      await page.click('[data-card] [data-open-task]');
      await page.until('the task page of s-cart', () => location.pathname === '/s/s-cart/overview' && !!document.querySelector('#task-sheet [role="tablist"]'));
      assert.equal(await page.eval(() => document.querySelector<HTMLElement>('#task-sheet button[aria-label="Back to the queue"]')?.innerText.replace(/\s+/g, ' ').trim()), 'Queue Esc');
      await page.click('#task-sheet button[aria-label="Back to the queue"]');
      await page.until('the queue with s-cart', () => location.pathname === '/' && !document.querySelector('#task-sheet') && document.querySelector<HTMLElement>('[data-card]')?.dataset.session === 's-cart');
    },
  },
  {
    name: 'task-page.narrow in a narrow window an open task covers the whole window, top bar included, with no sideways scroll',
    narrow: true,
    async run({ page, mock }) {
      await openFromWall(page, mock, 's-invoice');
      const box = await page.eval(() => {
        const r = document.querySelector('#task-sheet')!.getBoundingClientRect();
        return [r.top, r.left, Math.round(r.right) === innerWidth, Math.round(r.bottom) === innerHeight, document.scrollingElement!.scrollWidth <= innerWidth];
      });
      assert.deepEqual(box, [0, 0, true, true, true]);
    },
  },
  {
    name: 'theme the top bar\'s theme menu offers System, Light and Dark: each recolours the page at once against what the system prefers, the choice outlasts a reload, and System follows the system again',
    async run({ page, mock, themes, shot }) {
      const now = () => ({
        theme: document.documentElement.dataset.theme ?? 'system',
        scheme: getComputedStyle(document.documentElement).colorScheme,
        ground: getComputedStyle(document.body).backgroundColor,
        checked: document.querySelector<HTMLElement>('[data-theme-option][aria-checked="true"]')?.dataset.themeOption,
        label: document.querySelector('[data-theme-button]')?.getAttribute('aria-label'),
      });
      const pick = async (theme: string) => {
        await page.click('[data-theme-button]');
        await page.until('the theme menu', () => !!document.querySelector('#theme-menu:popover-open'));
        await page.click(`[data-theme-option="${theme}"]`);
        await page.until('the menu to close', () => !document.querySelector('#theme-menu:popover-open'));
      };
      // Once with the system in each scheme.
      await themes(async (prefers) => {
        await openQueue(page, mock);
        const system = await page.eval(now);
        assert.deepEqual({ ...system, ground: undefined }, { theme: 'system', scheme: 'light dark', ground: undefined, checked: 'system', label: 'Theme: System' });
        const other = prefers === 'dark' ? 'light' : 'dark';

        await pick(other);
        const forced = await page.eval(now);
        assert.deepEqual({ theme: forced.theme, scheme: forced.scheme, checked: forced.checked, label: forced.label }, { theme: other, scheme: other, checked: other, label: `Theme: ${other[0].toUpperCase()}${other.slice(1)}` });
        assert.notEqual(forced.ground, system.ground, 'the page did not recolour');
        await shot(`theme-${other}`);

        await page.goto(`${mock.url}/wall`);
        await page.until('the tiles', tiles);
        assert.deepEqual((await page.eval(now)).theme, other, 'the theme did not outlast a reload');

        await pick(prefers);
        assert.equal((await page.eval(now)).scheme, prefers);
        await pick('system');
        const back = await page.eval(now);
        assert.deepEqual({ theme: back.theme, ground: back.ground }, { theme: 'system', ground: system.ground });
      });
    },
  },
  {
    name: 'P8.clear /clear in a task with a name and an artifact keeps it one task: the Wall gains no tile, the open page stays on it with its name and its artifact, the Session fact names the new conversation and Earlier conversations the old one; a /resume into a conversation another task ran brings that task back and merges nothing',
    async run({ page, mock, shot }) {
      const wallTiles = () => [...document.querySelectorAll<HTMLElement>('[data-tile]')].map((t) => t.dataset.session ?? '').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      const before = await page.eval(wallTiles);
      await mock.post('/mock/patch', { id: 's-reviews', patch: { artifacts: [{ id: 'art-skeleton', title: 'Where the skeleton sits', at: Date.now() - 60_000 }] } });

      await openSheetOf(page, mock, 's-reviews');
      await mock.post('/mock/clear', { id: 's-reviews', conversation: 'c-fresh' });
      await page.until('the new conversation in the facts', () =>
        [...document.querySelectorAll('#task-sheet dt')].find((d) => d.textContent === 'Session')?.nextElementSibling?.querySelector('code')?.textContent === 'c-fresh');
      const page1 = await page.eval(() => {
        const sheet = document.querySelector<HTMLElement>('#task-sheet')!;
        const label = (name: string) => [...sheet.querySelectorAll('h3')].find((h) => h.textContent?.startsWith(name))?.closest('section');
        return {
          path: location.pathname,
          title: sheet.innerText.includes('Lazy-load product reviews'),
          artifacts: [...(label('Artifacts')?.querySelectorAll('strong') ?? [])].map((s) => s.textContent),
          earlier: [...(label('Earlier conversations')?.querySelectorAll('li') ?? [])].map((li) => li.querySelector('code')?.textContent),
        };
      });
      assert.deepEqual(page1, { path: '/s/s-reviews/overview', title: true, artifacts: ['Where the skeleton sits'], earlier: ['s-reviews'] });
      await shot('cleared-task');
      const state = await mock.get('/api/state');
      assert.ok(!state.sessions.some((s: { id: string }) => s.id === 'c-fresh'), 'the new conversation became a task of its own');

      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      assert.deepEqual(await page.eval(wallTiles), before);

      await mock.post('/mock/patch', { id: 's-stripe', patch: { archived: true } });
      await mock.post('/mock/resume', { id: 's-anchors', to: 's-stripe' });
      const after = await mock.get('/api/state');
      const pick = (id: string) => {
        const s = after.sessions.find((x: { id: string }) => x.id === id);
        return { conversation: s.conversation, history: s.history.length, status: s.status, archived: s.archived };
      };
      assert.deepEqual([pick('s-stripe'), pick('s-anchors')], [
        { conversation: 's-stripe', history: 0, status: 'idle', archived: false },
        { conversation: 's-anchors', history: 0, status: 'exited', archived: true },
      ]);
      assert.equal(after.sessions.length, state.sessions.length);
    },
  },
  {
    name: 'M1 New task across a folder of repos: the picker lists the folder first, which hides the worktree options and says where Claude starts; ⌘↵ starts it in an empty task folder; the worktrees Claude opens show in the facts, each PR it opens shows as its own chip named by its repository and linked, the Diff groups them by repository, the tile names the repositories it works in and their branch, and Clear task names each worktree and its loss and clears them all',
    async run({ page, mock, shot }) {
      const submit = () => document.querySelector('dialog#new-task textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await page.type('Rename the cart API on both sides');
      await page.click('dialog#new-task button[aria-haspopup="listbox"]');
      await page.until('the picker, its filter focused', () => !!document.querySelector('#new-task [data-repo-picker]:popover-open') &&
        document.activeElement === document.querySelector('#new-task [data-repo-picker] input'));
      const first = await page.eval(() => {
        const option = document.querySelector('#new-task [data-repo-picker] [role="option"]');
        return { folder: option?.hasAttribute('data-folder'), text: option?.textContent };
      });
      assert.deepEqual(first, { folder: true, text: 'code~/code3 repositories · Claude picks which to change' });
      await page.type('code');
      await page.key('Enter');
      await page.until('the picker to close', () => !document.querySelector('#new-task [data-repo-picker]:popover-open'));
      await page.click('dialog#new-task input[placeholder="fix-login-redirect"]');
      await page.type('cart api');
      const form = await page.eval(() => ({
        target: document.querySelector('dialog#new-task button[aria-haspopup="listbox"]')?.getAttribute('aria-label'),
        mode: !!document.querySelector('dialog#new-task input[name="mode"]'),
        branch: !!document.querySelector('dialog#new-task input[placeholder="cart-api"]'),
        hint: document.querySelector('dialog#new-task [data-hint]')?.textContent,
      }));
      assert.deepEqual(form, {
        target: 'Folder: code', mode: false, branch: false,
        hint: 'Starts Claude in ~/code/worktrees/cart-api, where it reads billing-api, docs-site, storefront and opens a worktree on the branch cart-api in each one it changes.',
      });
      await shot('new-task-folder');
      await page.eval(submit);
      const [created] = await logged(mock, 'the folder task', (e) => e.method === 'POST' && e.path === '/api/folder-tasks');
      const home = await mock.home();
      assert.deepEqual({ ...created.body, status: created.status }, { folder: `${home}/code`, name: 'cart-api', prompt: 'Rename the cart API on both sides', files: [], model: '', effort: '', status: 200 });
      const id: string = (await mock.get('/api/state')).sessions.find((x: { worktree: string }) => x.worktree === `${home}/code/worktrees/cart-api`).id;
      const before = await page.until('its facts', () => {
        const dl = document.querySelector('#task-sheet dl');
        return document.querySelector('#task-sheet h2')?.textContent === 'cart-api' && dl &&
          Object.fromEntries([...dl.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
      });
      assert.deepEqual([before.Folder, before.Path, before.Worktrees, before.Repository], ['code', '~/code/worktrees/cart-api', 'None yet; Claude opens one in each repository it changes', undefined]);

      await mock.post('/mock/open-worktree', { id, repo: 'storefront' });
      await mock.post('/mock/open-worktree', { id, repo: 'billing-api' });
      const after = await page.until('both worktrees in the facts', () => document.querySelectorAll('[data-task-worktrees] li').length === 2 &&
        [...document.querySelectorAll('[data-task-worktrees] li')].map((li) => li.textContent));
      assert.deepEqual(after, [
        'storefront ~/code/worktrees/cart-api/storefront on cart-api',
        'billing-api ~/code/worktrees/cart-api/billing-api on cart-api',
      ]);
      await mock.post('/mock/patch', { id, patch: { prs: [
        { id: 101, url: 'https://github.com/acme/storefront/pull/101', repo: 'storefront', result: 'PASSED all 9 checks', watching: false, at: Date.now() - 60_000 },
        { id: 57, url: 'https://github.com/acme/billing-api/pull/57', repo: 'billing-api', result: 'RUNNING 4 checks', watching: true, at: Date.now() },
      ] } });
      const chips = await page.until('a chip per PR', () => {
        const all = [...document.querySelectorAll('#task-sheet header [data-state][data-label]')];
        return all.length === 2 && all.map((c) => [c.textContent, c.getAttribute('href')]);
      });
      assert.deepEqual(chips, [
        ['storefront PR 101 · green', 'https://github.com/acme/storefront/pull/101'],
        ['billing-api PR 57 · checks running', 'https://github.com/acme/billing-api/pull/57'],
      ]);
      await shot('folder-task-facts');

      await page.key('3');
      const files = await page.until('the diff of both', () => {
        const all = [...document.querySelectorAll('section[data-file]')].map((s) => s.getAttribute('data-file')!);
        return all.length > 0 && all;
      });
      assert.ok(files.some((f) => f.startsWith('storefront/')) && files.some((f) => f.startsWith('billing-api/')), files.join(', '));
      assert.ok(files.every((f) => f.startsWith('storefront/') || f.startsWith('billing-api/')), files.join(', '));

      await page.goto(`${mock.url}/wall`);
      const where = await page.until('its tile', (task: string) => document.querySelector(`[data-tile][data-session="${task}"] [class*="where"]`)?.textContent, id);
      assert.equal(where, 'storefront, billing-api · cart-api');
      await page.click(`[data-tile][data-session="${id}"] button[aria-label="Session actions"]`);
      await page.until('its menu', menuItems);
      await page.click(':popover-open button', 'Clear task');
      const asked = await page.until('the delete dialog', () => {
        const d = document.querySelector<HTMLDialogElement>('dialog#delete-worktree');
        if (!d?.open || d.innerText.includes('Checking')) return null;
        return { title: d.querySelector('h2')?.textContent, path: d.querySelector('code')?.textContent, text: d.innerText, loss: [...d.querySelectorAll('li')].map((l) => l.textContent) };
      });
      assert.deepEqual({ ...asked, text: undefined }, {
        title: 'Clear the task and its task folder, with 2 worktrees?', path: '~/code/worktrees/cart-api', text: undefined,
        loss: ['storefront: 3 uncommitted or untracked files and 2 unpushed commits'],
      });
      assert.match(asked.text, /Removes the worktrees in storefront, billing-api and their local branch cart-api\./);
      await shot('folder-task-clear');
      await approveLoss(page);
      await page.click('dialog#delete-worktree button', 'Clear task');
      const [deleted] = await logged(mock, 'the deletion', (e) => e.method === 'POST' && e.action === 'delete-worktree');
      assert.deepEqual([deleted.sessionId, deleted.status], [id, 204]);
      await page.until('the tile to go', (task: string) => !document.querySelector(`[data-tile][data-session="${task}"]`), id);
      const state = await mock.get('/api/state');
      assert.ok(!state.repos.some((r: { worktrees: { path: string }[] }) => r.worktrees.some((w) => w.path.startsWith(`${home}/code/worktrees/cart-api/`))), 'the worktrees went');
    },
  },
];
