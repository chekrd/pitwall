import assert from 'node:assert/strict';
import { until } from '../cdp.ts';
import { approveLoss, byText, frontIs, logged, luminance, menuItems, openFromWall, openNewTask, openQueue, openSheetOf, ready, stateOf, still, tiles, toastsOf, whole, type Check } from '../helpers.ts';

export const usageFindings: Check[] = [
  {
    name: 'usage the top bar shows the 5-hour and weekly limits on the queue and the Wall, each with its share, its level and its reset time, the weekday too when it is not today; a new reading shows at once, a passed reset shows 0 % and no reading shows –',
    async run({ page, mock, shot }) {
      const usage = () => [...document.querySelectorAll<HTMLElement>('header [data-usage] [data-window]')].map((w) => ({
        window: w.dataset.window, text: w.innerText.replace(/\s+/g, ' ').trim(), level: w.dataset.level ?? null, title: w.dataset.explain ?? "",
      }));
      await openQueue(page, mock);
      const queue = await page.eval(usage);
      assert.deepEqual(queue.map((w) => ({ window: w.window, level: w.level })), [{ window: '5h', level: 'low' }, { window: '7d', level: 'mid' }]);
      assert.match(queue[0].text, /^5h 34% ↻ (?:\w+ )?\d\d:\d\d$/);
      assert.match(queue[1].text, /^7d 61% ↻ \w+ \d\d:\d\d$/);
      assert.match(queue[0].title, /^5-hour limit: 34% used · resets \d\d:\d\d · read at \d\d:\d\d$/);
      assert.match(queue[1].title, /^Weekly limit: 61% used · resets \w+ \d\d:\d\d · read at \d\d:\d\d$/);
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

      await mock.post('/mock/usage', { usage: null });
      await page.goto(`${mock.url}/wall`);
      await page.until('the Wall', () => !!document.querySelector('[data-tile]'));
      const none = await page.eval(usage);
      assert.deepEqual(none.map((w) => [w.text, w.level]), [['5h –', null], ['7d –', null]]);
      assert.match(none[0].title, /no reading yet/);
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
    name: 'P8.findings-decision a decision about the findings heads its options Claude\'s options, in the order Claude gave them, not ranked; each option names the findings it acts on and which were already answered on their own, the second opinion marks its pick, and the findings say the options answer them together',
    scenario: 'findings',
    async run({ page, mock, shot }) {
      const now = Date.now();
      await mock.post('/mock/patch', { id: 's-review', patch: {
        summary: { decision: {
          problem: 'Which review findings should Claude fix?', brief: 'Three issues, none verified.', context: '',
          options: [
            { label: 'Fix all three', description: 'Guard the double load, name the skeleton and move the margin to config/lazy.ts.', covers: [0, 1, 2] },
            { label: 'Fix the margin only', description: 'Move the 600 px margin to config/lazy.ts.', covers: [2] },
            { label: 'Leave them', description: 'Nothing changes.' },
          ],
        } },
        advice: {
          key: 's:t-review-4', state: 'done', startedAt: now - 60_000, at: now - 30_000, activity: null,
          choice: 'Fix the margin only', confidence: 70, answer: '', reasoning: 'The other two are already being handled.',
        },
      } });
      await openSheetOf(page, mock, 's-review');
      await page.until('the options', () => document.querySelectorAll('#task-sheet [data-option]').length === 3);
      const shown = await page.eval(() => {
        const group = document.querySelector<HTMLElement>('#task-sheet [role="group"][aria-label="Claude\'s options"]')!;
        const options = [...group.querySelectorAll<HTMLElement>('[data-option]')];
        return {
          head: group.firstElementChild!.textContent,
          covers: options.map((o) => o.querySelector('[data-covers]')?.textContent ?? null),
          tags: options.map((o) => o.querySelector('[class*="tags"]')!.textContent),
          note: document.querySelector('#task-sheet [data-findings-note]')?.textContent ?? null,
        };
      });
      assert.deepEqual(shown, {
        head: "Claude's optionsin the order Claude gave them, not ranked",
        covers: ['Acts on findings 1, 2 and 3 · 1 and 2 already answered on their own', 'Acts on finding 3', null],
        tags: ['', "Second opinion's pick · 70%", ''],
        note: "Claude's options above answer these together, in this session. A button on one finding starts a separate agent for just that one.",
      });
      await shot('findings-decision');

      await mock.post('/mock/patch', { id: 's-review', patch: { summary: { decision: { options: [{ label: 'Fix all three' }, { label: 'Leave them' }] } } } });
      await page.until('the note gone with the coverage', () => !document.querySelector('#task-sheet [data-findings-note]') && !document.querySelector('#task-sheet [data-covers]'));
    },
  },
  {
    name: 'P8.findings-solve Mark solved on a finding settles its open subtasks, or marks one without subtasks solved, which the toast\'s Undo, ⌘Z and Reopen undo; nothing starts',
    scenario: 'findings',
    async run({ page, mock, shot }) {
      const state = () => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-finding]')].map((f) => ({
        n: f.dataset.finding, settled: !!f.closest('[data-settled-findings]'), note: f.querySelector('[class*="rejected"] span')?.textContent ?? null,
      }));
      await openSheetOf(page, mock, 's-review');
      await page.until('the findings', () => document.querySelectorAll('#task-sheet [data-finding]').length === 3);
      assert.match(await page.eval(() => document.querySelector<HTMLElement>('#task-sheet [data-finding="1"] [data-response="solve"]')!.dataset.explain ?? ''), /its open 2 subtasks solved/);
      await shot('findings-solve');

      await page.click('#task-sheet [data-finding="1"] [data-response="solve"]');
      await page.until('#1 settled in its subtasks', () => !!document.querySelector('[data-settled-findings] [data-finding="1"]'));
      const resolved = await until('both subtasks resolved in the mock\'s log', async () => {
        const found = (await mock.log()).filter((e) => e.action === 'resolve' && e.status !== null);
        return found.length === 2 && found;
      });
      assert.deepEqual(resolved.map((e) => [e.sessionId, e.body.state]).toSorted(byText), [['s-review-1', 'solved'], ['s-review-2', 'solved']]);
      assert.equal(await page.eval(() => document.querySelector('[data-settled-findings] [data-finding="1"] [class*="rejected"] span')!.textContent), 'Solved in its 2 subtasks');

      await page.click('#task-sheet [data-finding="3"] [data-response="solve"]');
      await page.until('#3 marked solved', () => !!document.querySelector('[data-settled-findings] [data-finding="3"]'));
      const [marked] = await logged(mock, 'the mark', (e) => e.action === 'finding');
      assert.deepEqual(marked.body, { basis: 't-review-4', finding: 2, kind: 'solve', text: '' });
      assert.equal(await page.eval(() => document.querySelectorAll('#task-sheet [data-finding="3"] [data-subtask]').length), 0, 'a subtask started');
      assert.deepEqual(await page.eval(state), [
        { n: '1', settled: true, note: 'Solved in its 2 subtasks' },
        { n: '2', settled: true, note: 'Rejected: Covered by the a11y ticket' },
        { n: '3', settled: true, note: 'Solved' },
      ]);
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-settled-count]')!.textContent), '· all 3 settled');

      const reopened = '#task-sheet [data-finding="3"]:not([data-settled-findings] *) [data-response="solve"]';
      const toastKey = () => [...document.querySelectorAll('[data-toast][data-kind="undo"]')].find((t) => t.textContent.startsWith('Solved #3 '))?.querySelector('kbd')?.textContent ?? null;
      assert.equal(await page.until('the Undo toast', toastKey), '⌘Z');
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.key('z', { meta: true });
      await page.until('#3 open again by ⌘Z', (sel: string) => !!document.querySelector(sel), reopened);
      assert.equal(await page.eval(toastKey), null, 'the toast stayed');
      await logged(mock, 'the reopen', (e) => e.action === 'finding' && e.body.kind === 'reopen');

      await page.click('#task-sheet [data-finding="3"] [data-response="solve"]');
      await page.until('#3 marked solved again', () => !!document.querySelector('[data-settled-findings] [data-finding="3"]'));
      await page.eval(() => { document.querySelector<HTMLDetailsElement>('#task-sheet [data-settled-findings]')!.open = true; });
      await page.click('#task-sheet [data-finding="3"] [class*="rejected"] button');
      await page.until('#3 open again', (sel) => !!document.querySelector(sel), reopened);
    },
  },
  {
    name: 'P8.findings a review lists its findings on the task page: #2 rejected, #1 with its subtask at work; Accept with a note on #3 starts a subtask under it, Reject and Reopen mark only; a subtask names its task above its title and atop its Overview, with the finding, the answer and its sibling, and leads back; the Your turn card lists them in place of the reply; on the Wall a subtask has no tile: its task\'s tile lists none and reads In progress while one works, and its page lists them all; a subtask has no card in the queue either, and its decision is answered on its page, which has no Open its card; Mark solved and Drop settle a subtask and open its task in its place, and the task counts the ones still open',
    scenario: 'findings',
    async run({ themes, page, mock, shot }) {
      const items = () => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-finding]')].map((f) => ({
        n: f.dataset.finding, rejected: f.hasAttribute('data-rejected'), settled: !!f.closest('[data-settled-findings]'),
        subtasks: [...f.querySelectorAll('[data-subtask]')].map((b) => (b as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
      }));
      await openSheetOf(page, mock, 's-review');
      await page.until('the findings', () => document.querySelectorAll('#task-sheet [data-finding]').length === 3);
      assert.deepEqual(await page.eval(items), [
        { n: '1', rejected: false, settled: false, subtasks: ['Fix In progress', 'Second look Decide'] },
        { n: '3', rejected: false, settled: false, subtasks: [] },
        { n: '2', rejected: true, settled: true, subtasks: [] },
      ]);
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-settled-count]')!.textContent), '· 2 of 3 open');
      assert.equal(await page.eval(() => document.querySelector<HTMLDetailsElement>('#task-sheet [data-settled-findings]')!.open), false, 'settled ones start folded');
      await shot('findings');

      await page.click('#task-sheet [data-finding="3"] button[aria-expanded]');
      await page.click('#task-sheet [data-finding="3"] textarea');
      await page.type('Use config/lazy.ts');
      await page.click('#task-sheet [data-finding="3"] [data-response="accept"]');
      const [posted] = await logged(mock, 'the accept', (e) => e.action === 'finding');
      assert.deepEqual(posted.body, { basis: 't-review-4', finding: 2, kind: 'accept', text: 'Use config/lazy.ts' });
      await page.until('the subtask under #3', () => document.querySelectorAll('#task-sheet [data-finding="3"] [data-subtask]').length === 1);
      const [started] = await page.until('the toast', toastsOf, 'info');
      assert.match(started.text, /Started #3 Fix/);
      await themes(async (scheme) => {
        const bg = await page.eval(() => getComputedStyle(document.querySelector("[data-toast][data-kind=\"info\"]")!).backgroundColor);
        assert.ok(luminance(bg) < 0.05, `the toast ${bg} is not dark in ${scheme}`);
      });
      assert.equal(await page.eval(() => document.querySelector<HTMLTextAreaElement>('#task-sheet [data-finding="3"] textarea')!.value), '');

      await page.click('#task-sheet [data-finding="1"] [data-response="reject"]');
      await page.until('#1 rejected', () => document.querySelector('#task-sheet [data-finding="1"]')!.hasAttribute('data-rejected'));
      await page.click('#task-sheet [data-settled-findings] summary');
      await page.click('#task-sheet [data-finding="2"] button', 'Reopen');
      await page.until('#2 open again', () => !document.querySelector('#task-sheet [data-finding="2"]')!.hasAttribute('data-rejected'));
      assert.deepEqual((await stateOf(mock, 's-review')).findings.items.map((f: { rejected?: unknown }) => !!f.rejected), [true, false, false]);

      await page.click('#task-sheet [data-subtask="s-review-1"]');
      await page.until('the subtask page', () => location.pathname === '/s/s-review-1/overview' && !!document.querySelector('#task-sheet [aria-label="Subtask of"]'));
      await shot('subtask');
      await page.click('#task-sheet header button[aria-label="Session actions"]');
      assert.deepEqual(await page.until('the subtask menu', menuItems), ['Terminal', 'Open in Finder', 'Open in VS Code', 'Open in Ghostty', 'Quit Claude', 'Mark solved', 'Drop']);
      await page.key('Escape');
      await page.until('the menu to close', () => !document.querySelector(':popover-open:not([popover="manual"])'));
      const text = (sel: string) => page.eval((q) => document.querySelector<HTMLElement>(q)!.innerText.replace(/\s+/g, ' ').trim(), sel);
      assert.equal(await text('#task-sheet header [data-parent]'), 'Subtask of Review the lazy reviews branch');
      const origin = await text('#task-sheet [aria-label="Subtask of"]');
      assert.match(origin, /^Subtask of Review the lazy reviews branch Your turn Back to the task 1 Reviews load twice on a fast scroll src\/reviews\/LazyReviews\.tsx:41 The IntersectionObserver .* Fix “?Guard it with a ref”? Second look Decide Done with it\? Mark solved Drop$/i);
      await page.click('#task-sheet [aria-label="Subtask of"] [data-subtask="s-review-2"]');
      await page.until('the sibling', () => location.pathname === '/s/s-review-2/overview');
      await page.click('#task-sheet header [data-parent] button');
      await page.until('back on the review', () => location.pathname === '/s/s-review/overview');

      await openQueue(page, mock);
      await page.click('[data-segment][data-session="s-review"]');
      await page.until('the review at the front', frontIs, 's-review');
      assert.equal(await page.eval(() => document.querySelectorAll('[data-card] [data-finding]').length), 3);
      await page.until('the card to settle', still);
      await shot('findings-card');

      await page.click('a[href="/wall"]');
      await page.until('the Wall', () => !!document.querySelector('[data-tile][data-session="s-review"]'));
      assert.equal(await page.eval(() => document.querySelectorAll('[data-tile] [data-parent], [data-tile][data-session^="s-review-"]').length), 0, 'no subtask has a tile');
      // The task itself is idle, but its subtask #1 works, so its tile reads In progress and lists no subtasks.
      assert.deepEqual(await page.eval(() => {
        const tile = document.querySelector<HTMLElement>('[data-tile][data-session="s-review"]')!;
        return { attention: tile.dataset.attention, wants: tile.dataset.wants, state: tile.querySelector('header')!.innerText.split('\n')[0], listed: !!tile.querySelector('[data-subtasks], [data-subtask]') };
      }), { attention: 'working', wants: 'decide', state: 'IN PROGRESS', listed: false });
      await shot('findings-wall');
      await page.click('[data-tile][data-session="s-review"]');
      await page.until('the review', () => location.pathname === '/s/s-review/overview');
      await page.click('#task-sheet [data-subtask-list] [data-subtask="s-review-2"]');
      await page.until('the subtask from its task page', () => location.pathname === '/s/s-review-2/overview');
      assert.deepEqual(await page.until('its decision on its page', () => {
        const box = document.querySelector<HTMLElement>('#task-sheet [data-queued]');
        return box && { kicker: box.querySelector('span')!.textContent, toCard: [...box.querySelectorAll('button')].some((b) => b.textContent === 'Open its card'), options: box.querySelectorAll('[data-option]').length > 0 };
      }), { kicker: 'Decision', toCard: false, options: true });
      assert.equal(await page.eval(() => document.querySelectorAll('[data-segment][data-session^="s-review-"]').length), 0, 'no subtask has a card in the queue');
      await page.click('#task-sheet header [data-parent] button');
      await page.until('the review again', () => location.pathname === '/s/s-review/overview');
      const listed = await page.eval(() => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-subtask-list] [data-subtask]')].map((b) => `${b.dataset.subtask}:${b.dataset.attention}`));
      assert.equal(listed.length, 4);
      assert.deepEqual(listed.slice(0, 3), ['s-review-2:decide', 's-review-1:working', 's-review-1-1:idle']);
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-subtask-list] li')].map((l) => l.dataset.depth)), ['0', '0', '1', '0']);
      assert.ok(await page.eval(() => !!document.querySelector('#task-sheet aside [data-subtask-list]')), 'the subtasks are listed beside the facts');
      await shot('subtask-list');

      await page.click('#task-sheet [data-subtask-list] [data-subtask="s-review-1-1"]');
      await page.until('the subtask of a subtask', () => location.pathname === '/s/s-review-1-1/overview');
      assert.equal(await text('#task-sheet header [data-parent]'), 'Subtask of Review the lazy reviews branch › #1 Fix · Reviews load twice on a fast scroll');
      assert.match(await text('#task-sheet [aria-label="Subtask of"]'), /^Subtask of #1 Fix · Reviews load twice on a fast scroll In progress Back to the task 1 The guard is not reset on unmount/i);
      await shot('subtask-nested');
      await page.click('#task-sheet [data-resolve] button', 'Mark solved');
      await page.until('its task, the fix, in its place', () => location.pathname === '/s/s-review-1/overview');
      const [solved] = await page.until('the undo toast', toastsOf, 'undo');
      assert.match(solved.text, /Solved #1 Explain/);
      assert.deepEqual((await stateOf(mock, 's-review-1-1')).resolution?.state, 'solved');
      await page.until('listed solved', () => !!document.querySelector('#task-sheet [data-subtask-list] li[data-resolution="solved"]'));
      assert.equal(await page.eval(() => document.querySelector<HTMLDetailsElement>('#task-sheet [data-settled-subtasks]')?.open), false, 'a solved subtask folds away');
      await page.until('the fix\'s finding settled by it', () => document.querySelector('#task-sheet [data-findings] [data-settled-count]')?.textContent === '· all 1 settled');
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-finding="1"][data-settled="solved"] [class*="rejected"]')!.textContent), 'Solved in its subtask');
      await page.click('#task-sheet header [data-parent] button');
      await page.until('the review from the chain', () => location.pathname === '/s/s-review/overview');
      await page.until('3 open', () => document.querySelector('#task-sheet header [data-open-count]')?.textContent === '3 of 4 subtasks open');
      await page.click('#task-sheet [data-subtask-list] [data-subtask="s-review-2"]');
      await page.until('the second look', () => location.pathname === '/s/s-review-2/overview');
      await page.click('#task-sheet header button[aria-label="Session actions"]');
      await page.click(':popover-open button', 'Drop');
      await page.until('the review in its place', () => location.pathname === '/s/s-review/overview');
      await page.until('2 open', () => document.querySelector('#task-sheet header [data-open-count]')?.textContent === '2 of 4 subtasks open');
      assert.equal(await text('#task-sheet [data-open-count]:not(header *)'), '· 2 of 4 open');
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-settled-subtasks] li')].map((l) => `${l.querySelector<HTMLElement>('[data-subtask]')!.dataset.subtask}:${l.dataset.resolution}:${l.dataset.depth}`)), ['s-review-1-1:solved:0', 's-review-2:dropped:0']);
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-subtask-list] > ul li')].map((l) => l.dataset.resolution ?? 'open')), ['open', 'open'], 'the open ones stay above');
      await page.click('#task-sheet [data-settled-subtasks] summary');
      await shot('subtasks-settled');
      const rest = (await mock.get('/api/state')).sessions.filter((s: { parent: unknown; resolution: unknown }) => s.parent && !s.resolution);
      assert.equal(rest.length, 2);
      for (const s of rest) await mock.post(`/api/sessions/${s.id}/resolve`, { state: 'solved' });
      await page.until('all settled', () => document.querySelector('#task-sheet header [data-open-count]')?.textContent === 'All 4 subtasks solved or dropped');
      assert.match(await page.eval(() => document.querySelector<HTMLElement>('#task-sheet header [data-open-count]')!.dataset.explain!), /^Solved: “.+”\. Dropped: “.+”\.$/);
      await page.until('#3 settled with its subtask', () => document.querySelector<HTMLElement>('#task-sheet [data-finding="3"]')?.dataset.settled === 'solved');
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-settled-findings] [data-finding]')].map((f) => `${f.dataset.finding}:${f.dataset.settled}`)), ['1:rejected', '3:solved']);
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-findings] [data-settled-count]')!.textContent), '· 1 of 3 open');
      await page.click('#task-sheet [data-settled-findings] summary');
      await shot('findings-settled');

      await page.click('#task-sheet header button[aria-label="Session actions"]');
      await page.click(':popover-open button', 'Clear task');
      const cleared = await page.until('the clear dialog', () => {
        const d = document.querySelector<HTMLElement>('dialog#delete-worktree[open]');
        return d && !d.textContent.includes('Checking') && d.innerText;
      });
      assert.match(cleared, /Its 4 subtasks go with it, their Claudes too\./);
      await approveLoss(page);
      await page.click('dialog#delete-worktree button', 'Clear task');
      await until('the task and its subtasks gone', async () => !(await mock.get('/api/state')).sessions.some((s: { id: string }) => s.id.startsWith('s-review')));
    },
  },
  {
    name: 'P8.clear /clear in a subtask with a name, a parent, a subtask of its own and an artifact keeps it one task: the Wall gains no tile, the open page stays on it with its name, its task, its subtask and its artifact, the Session fact names the new conversation and Earlier conversations the old one; a /resume into a conversation another task ran brings that task back and merges nothing',
    scenario: 'findings',
    async run({ page, mock, shot }) {
      const wallTiles = () => [...document.querySelectorAll<HTMLElement>('[data-tile]')].map((t) => t.dataset.session ?? '').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      const before = await page.eval(wallTiles);
      await mock.post('/mock/patch', { id: 's-review-1', patch: { artifacts: [{ id: 'art-guard', title: 'Where the second load starts', at: Date.now() - 60_000 }] } });

      await openSheetOf(page, mock, 's-review-1');
      await page.until('the subtask list', () => !!document.querySelector('#task-sheet [data-subtask-list]'));
      await mock.post('/mock/clear', { id: 's-review-1', conversation: 'c-fresh' });
      await page.until('the new conversation in the facts', () =>
        [...document.querySelectorAll('#task-sheet dt')].find((d) => d.textContent === 'Session')?.nextElementSibling?.querySelector('code')?.textContent === 'c-fresh');
      const page1 = await page.eval(() => {
        const sheet = document.querySelector<HTMLElement>('#task-sheet')!;
        const label = (name: string) => [...sheet.querySelectorAll('h3')].find((h) => h.textContent?.startsWith(name))?.closest('section');
        return {
          path: location.pathname,
          title: sheet.innerText.includes('#1 Fix · Reviews load twice on a fast scroll'),
          task: sheet.innerText.includes('Review the lazy reviews branch'),
          subtasks: sheet.querySelector('[data-subtask-list]')?.textContent?.includes('The guard is not reset on unmount'),
          artifacts: [...(label('Artifacts')?.querySelectorAll('strong') ?? [])].map((s) => s.textContent),
          earlier: [...(label('Earlier conversations')?.querySelectorAll('li') ?? [])].map((li) => li.querySelector('code')?.textContent),
        };
      });
      assert.deepEqual(page1, {
        path: '/s/s-review-1/overview', title: true, task: true, subtasks: true, artifacts: ['Where the second load starts'], earlier: ['s-review-1'],
      });
      await shot('cleared-task');
      const state = await mock.get('/api/state');
      const ids = state.sessions.map((s: { id: string }) => s.id);
      assert.ok(!ids.includes('c-fresh'), 'the new conversation became a task of its own');
      assert.equal(state.sessions.find((s: { id: string }) => s.id === 's-review-1-1').parent.id, 's-review-1');

      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      assert.deepEqual(await page.eval(wallTiles), before);

      await mock.post('/mock/patch', { id: 's-review-2', patch: { status: 'exited', pid: null, archived: true } });
      await mock.post('/mock/resume', { id: 's-review-1-1', to: 's-review-2' });
      const after = await mock.get('/api/state');
      const pick = (id: string) => {
        const s = after.sessions.find((x: { id: string }) => x.id === id);
        return { conversation: s.conversation, history: s.history.length, status: s.status, archived: s.archived };
      };
      assert.deepEqual([pick('s-review-2'), pick('s-review-1-1')], [
        { conversation: 's-review-2', history: 0, status: 'idle', archived: false },
        { conversation: 's-review-1-1', history: 0, status: 'exited', archived: true },
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
