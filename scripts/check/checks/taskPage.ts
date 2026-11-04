import assert from 'node:assert/strict';
import { uploadsDir } from '../../../server/uploadPaths.ts';
import { sleep, until } from '../cdp.ts';
import { approveLoss, clearDisabled, logged, menuItems, openFromWall, openSheetOf, settled, sheetOpen, tiles, toastsOf, type Check } from '../helpers.ts';

export const taskPage: Check[] = [
  {
    name: 'P4.6 browser Back closes the sheet; a sheet whose task goes away closes with "That task is gone."',
    async run({ page, mock }) {
      await openFromWall(page, mock, 's-invoice');
      await page.eval(() => history.back());
      await page.until('the sheet to close on Back', () => !document.querySelector('#task-sheet') && location.pathname === '/wall');

      await openFromWall(page, mock, 's-split');
      await mock.post('/api/sessions/s-split/forget');
      await page.until('the sheet to close', () => !document.querySelector('#task-sheet') && location.pathname === '/wall');
      assert.deepEqual(await page.until('the toast', toastsOf, 'info'), [{ kind: 'info', text: 'That task is gone.', inSheet: false, hit: true }]);
    },
  },
  {
    name: 'P4.7 Artifacts: 4 opens the list as a column beside a sandboxed frame of the newest artifact, with Open in new tab as a link; another artifact replaces the entry',
    async run({ page, mock, shot }) {
      await openSheetOf(page, mock, 's-cart');
      const entries = await page.eval(() => window.navigation.entries().length);
      await page.until('the Artifacts tab', () => [...document.querySelectorAll('#task-sheet [role="tab"]')].some((t) => t.textContent?.startsWith('Artifacts')));
      await page.key('4');
      await page.until('the artifacts', () => location.pathname === '/s/s-cart/artifacts' && document.querySelector('#task-sheet iframe') !== null);
      const shown = await page.eval(() => {
        const frame = document.querySelector('#task-sheet iframe')!;
        const link = [...document.querySelectorAll<HTMLAnchorElement>('#task-sheet a')].find((a) => a.textContent?.includes('Open in new tab'));
        return {
          column: getComputedStyle(document.querySelector('[role="tablist"][aria-label="Artifacts"]')!).flexDirection,
          list: [...document.querySelectorAll('[aria-label="Artifacts"] [role="tab"] strong')].map((t) => t.textContent),
          sandbox: frame.getAttribute('sandbox'),
          src: frame.getAttribute('src'),
          link: link && [link.getAttribute('href'), link.target],
        };
      });
      assert.deepEqual(shown, {
        column: 'column', list: ['Login flow with the merge step', 'Cart merge — before and after'], sandbox: 'allow-scripts',
        src: '/api/sessions/s-cart/artifacts/art-cart-2', link: ['/api/sessions/s-cart/artifacts/art-cart-2', '_blank'],
      });
      await page.until('the sheet to settle', settled);
      await shot('sheet-artifacts');
      await page.click('[aria-label="Artifacts"] [role="tab"]', 'Cart merge');
      await page.until('the other artifact', () => location.pathname === '/s/s-cart/artifacts/art-cart-1' &&
        document.querySelector('#task-sheet iframe')?.getAttribute('src') === '/api/sessions/s-cart/artifacts/art-cart-1');
      assert.equal(await page.eval(() => window.navigation.entries().length), entries, 'a tab or an artifact pushed an entry');
    },
  },
  {
    name: 'P4.8 rename: Esc keeps the title and the sheet; Enter sends rename with the new title',
    async run({ page, mock, shot }) {
      await openSheetOf(page, mock, 's-reviews');
      const title = () => document.querySelector('#task-sheet h2')?.textContent;
      await page.click('#task-sheet h2 button');
      await page.until('the rename field', () => document.activeElement?.getAttribute('aria-label') === 'Task name');
      await page.type(' X');
      await page.key('Escape');
      await page.until('the title back', () => document.querySelector('#task-sheet h2')?.textContent === 'Lazy-load product reviews');
      assert.equal(await page.eval(sheetOpen), true, 'Esc in the rename field closed the sheet');
      await page.click('#task-sheet h2 button');
      await page.until('the rename field', () => document.activeElement?.getAttribute('aria-label') === 'Task name');
      await page.type(' X');
      await shot('rename');
      await page.key('Enter');
      const [renamed] = await logged(mock, 'the rename', (e) => e.action === 'rename');
      assert.deepEqual([renamed.sessionId, renamed.body, renamed.status], ['s-reviews', { title: 'Lazy-load product reviews X' }, 204]);
      await page.until('the new title', () => document.querySelector('#task-sheet h2')?.textContent === 'Lazy-load product reviews X');
      assert.equal(await page.eval(title), 'Lazy-load product reviews X');
    },
  },
  {
    name: 'P4.9 the ⋯ menu lists what each session can do; Clear task…, or the trash beside the ⋯ on a task tile, asks in a dialog that names the branch, the path and the loss, starts on Cancel and closes on Esc; a failed loss check says so; Clear task deletes',
    expectedErrors: [/status of 400/],
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      const open = async (id: string) => {
        await page.click(`[data-tile][data-session="${id}"] button[aria-label="Session actions"]`);
        return page.until(`the menu of ${id}`, menuItems);
      };
      assert.deepEqual(await open('s-stripe'), ['Continue', 'Open in Finder', 'Open in VS Code', 'Archive', 'Remove from list', 'Clear task…']);
      await page.key('Escape');
      await page.until('the menu to close', () => !document.querySelector(':popover-open'));
      assert.deepEqual(await open('s-invoice'), ['Terminal', 'Open in Finder', 'Open in VS Code', 'Quit Claude', 'Archive', 'Clear task…']);
      await shot('session-menu');

      const asked = () => {
        const d = document.querySelector<HTMLDialogElement>('dialog#delete-worktree');
        if (!d?.open || d.innerText.includes('Checking')) return null;
        return {
          title: d.querySelector('h2')?.textContent,
          path: d.querySelector('code')?.textContent,
          text: d.innerText,
          loss: [...d.querySelectorAll('li')].map((l) => l.textContent),
          focus: document.activeElement?.textContent,
        };
      };
      await page.click(':popover-open button', 'Clear task');
      const shown = await page.until('the delete dialog', asked);
      assert.deepEqual({ ...shown, text: undefined }, {
        title: 'Clear the task, its worktree and its local branch invoice-rounding?', path: '~/code/worktrees/invoice-rounding/billing-api', text: undefined,
        loss: ['3 uncommitted or untracked files', '2 unpushed commits'], focus: 'Cancel',
      });
      assert.match(shown.text, /Not everything is pushed\. This throws away:/);
      await page.until('the dialog to settle', settled);
      await shot('delete-dialog');
      await page.key('Escape');
      await page.until('the dialog to close', () => !document.querySelector('dialog#delete-worktree[open]'));

      await open('s-stripe');
      await page.click(':popover-open button', 'Clear task');
      const failed = await page.until('the failed loss check', asked);
      assert.match(failed.text, /Could not check what would be lost \(git status failed: fatal: unable to read the index\); uncommitted changes and unpushed commits may be lost\./);
      assert.match(failed.text, /Clear it anyway, whatever is lost/);
      assert.equal(await page.eval(clearDisabled), true, 'Clear task works after a failed loss check without approval');
      await page.key('Escape');
      await page.until('the dialog to close', () => !document.querySelector('dialog#delete-worktree[open]'));

      assert.deepEqual(await page.eval(() => [...document.querySelectorAll<HTMLElement>('[data-tile]')].filter((t) => !t.querySelector('[data-clear]')).map((t) => t.dataset.session)),
        await page.eval(() => [...document.querySelectorAll<HTMLElement>('[data-tile]')].filter((t) => t.querySelector('[data-parent]')).map((t) => t.dataset.session)),
        'a tile without the Clear task button is not a subtask');
      await page.click('[data-tile][data-session="s-invoice"] button[aria-label="Clear task"]');
      assert.equal((await page.until('the delete dialog', asked)).focus, 'Cancel', 'the trash starts on Cancel when something would be lost');
      assert.equal(await page.eval(clearDisabled), true, 'Clear task works before the loss is approved');
      await assert.rejects(mock.post('/api/sessions/s-invoice/delete-worktree', {}), /: 400 .*not everything is pushed/, 'the server clears unpushed work without approval');
      await approveLoss(page);
      assert.equal(await page.eval(clearDisabled), false, 'approving the loss leaves Clear task disabled');
      await page.click('dialog#delete-worktree button', 'Clear task');
      const [deleted] = await logged(mock, 'the deletion', (e) => e.method === 'POST' && e.action === 'delete-worktree' && e.body?.discard === true);
      assert.deepEqual([deleted.sessionId, deleted.status], ['s-invoice', 204]);
      await page.until('the tile to go', () => !document.querySelector('[data-tile][data-session="s-invoice"]'));
    },
  },
  {
    name: 'P4.9.checkout a task in the main checkout says it has no worktree in its facts; the trash in its page header asks to clear only the task, says the checkout stays on its branch and, as nothing is lost, starts on Clear task, so Enter removes the task alone',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-edge/overview`);
      await page.until('the task page', sheetOpen);
      await page.until('Worktree None', () => [...document.querySelectorAll<HTMLElement>('#task-sheet dt')].find((d) => d.textContent === 'Worktree')?.nextElementSibling?.textContent === 'None');
      await page.click('#task-sheet button[aria-label="Session actions"]');
      assert.ok((await page.until('the menu', menuItems)).includes('Clear task…'), 'no Clear task… for a task in the main checkout');
      await page.key('Escape');
      await page.until('the menu to close', () => !document.querySelector(':popover-open'));
      await shot('sheet-head');
      await page.click('#task-sheet button[aria-label="Clear task"]');
      const shown = await page.until('the dialog', () => {
        const d = document.querySelector<HTMLDialogElement>('dialog#delete-worktree');
        return d?.open && !d.innerText.includes('Checking') && document.activeElement?.textContent === 'Clear task' ? { title: d.querySelector('h2')?.textContent?.trim(), text: d.innerText, loss: d.querySelectorAll('li').length } : null;
      });
      assert.deepEqual({ title: shown.title, loss: shown.loss }, { title: 'Clear the task?', loss: 0 });
      assert.match(shown.text, /main checkout, which stays as it is, on main\./);
      await page.key('Enter');
      const [cleared] = await logged(mock, 'the clearing', (e) => e.method === 'POST' && e.action === 'delete-worktree');
      assert.deepEqual([cleared.sessionId, cleared.status], ['s-edge', 204]);
      const after = await mock.get('/api/state');
      const home = await mock.home();
      assert.equal(after.sessions.some((x: { id: string }) => x.id === 's-edge'), false);
      assert.ok(after.repos.find((r: { id: number }) => r.id === 1).worktrees.some((w: { path: string; isMain: boolean }) => w.isMain && w.path === `${home}/code/storefront`), 'the checkout went');
    },
  },
  {
    name: 'P4.9.gone a task whose worktree was removed outside the board can still be cleared: the dialog says the worktree is already gone, and the task leaves',
    async run({ page, mock }) {
      await mock.post('/mock/patch', { id: 's-edge', patch: { worktree: `${await mock.home()}/code/worktrees/removed/storefront` } });
      await page.goto(`${mock.url}/s/s-edge/overview`);
      await page.until('the task page', sheetOpen);
      await page.click('#task-sheet button[aria-label="Session actions"]');
      await page.until('the menu', menuItems);
      await page.click(':popover-open button', 'Clear task');
      const shown = await page.until('the dialog', () => {
        const d = document.querySelector<HTMLDialogElement>('dialog#delete-worktree');
        return d?.open && !d.innerText.includes('Checking') ? { title: d.querySelector('h2')?.textContent?.trim(), text: d.innerText } : null;
      });
      assert.equal(shown.title, 'Clear the task?');
      assert.match(shown.text, /Its worktree is already gone\./);
      await page.click('dialog#delete-worktree button', 'Clear task');
      const [cleared] = await logged(mock, 'the clearing', (e) => e.method === 'POST' && e.action === 'delete-worktree');
      assert.deepEqual([cleared.sessionId, cleared.status], ['s-edge', 204]);
      assert.equal((await mock.get('/api/state')).sessions.some((x: { id: string }) => x.id === 's-edge'), false);
    },
  },
  {
    name: 'P4.9.shared a task started in a worktree another task works in: Clear task asks to clear only the task, says the worktree stays because another task works in it, and as nothing is lost starts on Clear task; the other task and the worktree stay',
    async run({ page, mock }) {
      const before = await mock.get('/api/state');
      const worktree = before.sessions.find((x: { id: string }) => x.id === 's-search').worktree;
      await mock.post('/mock/add', { template: 'idle', id: 's-twin', worktree, title: 'Another task in search-typos' });
      await page.goto(`${mock.url}/s/s-twin/overview`);
      await page.until('the task page', sheetOpen);
      await page.click('#task-sheet button[aria-label="Clear task"]');
      const shown = await page.until('the dialog', () => {
        const d = document.querySelector<HTMLDialogElement>('dialog#delete-worktree');
        return d?.open && !d.innerText.includes('Checking') && document.activeElement?.textContent === 'Clear task'
          ? { title: d.querySelector('h2')?.textContent?.trim(), text: d.querySelector('[data-shared]')?.textContent, loss: d.querySelectorAll('li').length, approve: !!d.querySelector('[data-approve]') }
          : null;
      });
      assert.deepEqual({ ...shown, text: undefined }, { title: 'Clear the task?', text: undefined, loss: 0, approve: false });
      assert.match(shown.text ?? '', /Another task on the board, archived or not, works in this worktree too, so it stays as it is, on \S+\. Clearing that task as well removes it\./);
      await page.key('Enter');
      const [cleared] = await logged(mock, 'the clearing', (e) => e.method === 'POST' && e.action === 'delete-worktree');
      assert.deepEqual([cleared.sessionId, cleared.status], ['s-twin', 204]);
      await until('s-twin gone', async () => !(await mock.get('/api/state')).sessions.some((x: { id: string }) => x.id === 's-twin'));
      const after = await mock.get('/api/state');
      assert.ok(after.sessions.some((x: { id: string }) => x.id === 's-search'), 'the other task went');
      assert.ok(after.repos.some((r: { worktrees: { path: string }[] }) => r.worktrees.some((w) => w.path === worktree)), 'the worktree went');
    },
  },
  {
    name: 'P4.9.clearing a Clear task whose removal takes minutes: from the click until it is done the task and its subtask show Clearing…, without a message box, Claude actions or another trash; a second Clear task joins the running removal instead of starting one; a failed removal drops the mark and shows its error on the task until Dismiss',
    expectedErrors: [/status of 400/, /Claude did not quit/],
    async run({ page, mock, shot }) {
      const worktree = `${await mock.home()}/code/worktrees/search-typos/storefront`;
      const ids = ['s-search', 's-sub'];
      await mock.post('/mock/add', { template: 'idle', id: 's-sub', worktree, title: 'Fix: typo ranking', parent: { id: 's-search', basis: 'b', finding: 0, title: 'Typo ranking', kind: 'accept', text: '' } });
      const clear = async () => {
        await page.until('the delete dialog', () => {
          const d = document.querySelector<HTMLDialogElement>('dialog#delete-worktree');
          return d?.open && !d.innerText.includes('Checking');
        });
        await approveLoss(page);
        await page.click('dialog#delete-worktree button', 'Clear task');
      };
      const tileOf = (id: string) => {
        const t = document.querySelector<HTMLElement>(`[data-tile][data-session="${id}"]`);
        return t && { attention: t.dataset.attention, label: t.querySelector('header [class*="state"]')?.textContent, text: t.querySelector('p')?.textContent, trash: !!t.querySelector('[data-clear]') };
      };

      await mock.post('/mock/clear-hold', {});
      await page.goto(`${mock.url}/s/s-search/overview`);
      await page.until('the task page', sheetOpen);
      await page.click('#task-sheet header button[aria-label="Session actions"]');
      await page.until('the menu', menuItems);
      await page.click(':popover-open button', 'Clear task');
      await clear();
      await page.goto(`${mock.url}/wall`);
      const tiles = await page.until('the tile clearing', (all: string[]) => {
        const shown = all.map((id) => {
          const t = document.querySelector<HTMLElement>(`[data-tile][data-session="${id}"]`);
          return t && { attention: t.dataset.attention, label: t.querySelector('header [class*="state"]')?.textContent, trash: !!t.querySelector('[data-clear]') };
        });
        return shown.every((t) => t?.attention === 'clearing') && shown;
      }, ['s-search']);
      assert.deepEqual(tiles, [{ attention: 'clearing', label: 'Clearing…', trash: false }]);
      assert.notEqual((await page.eval(tileOf, 's-cart'))?.attention, 'clearing', 'a task in another worktree is not clearing');
      const state = (await mock.get('/api/state')).sessions as { id: string; clearing: boolean; clearError: string | null }[];
      assert.deepEqual(state.filter((s) => s.clearing).map((s) => s.id).sort(), ids);
      await shot('clearing-tiles');

      await page.goto(`${mock.url}/s/s-search/overview`);
      const page1 = await page.until('the clearing section', () => document.querySelector('#task-sheet [data-clearing]')?.textContent);
      assert.match(page1, /Clearing the task.*the worktree is being removed/);
      assert.equal(await page.eval(() => !!document.querySelector('#task-sheet [data-ux-section="message box"]')), false, 'no message box while clearing');
      await page.click('#task-sheet header button[aria-label="Session actions"]');
      assert.deepEqual(await page.until('the menu', menuItems), ['Open in Finder', 'Open in VS Code']);
      await page.key('Escape');
      await shot('clearing-page');

      const second = mock.post('/api/sessions/s-search/delete-worktree', { discard: true });
      await sleep(300);
      assert.equal((await mock.get('/api/state')).sessions.filter((s: { id: string }) => ids.includes(s.id)).length, 2, 'the held removal is still running');
      await mock.post('/mock/clear-release', {});
      await second;
      const removals = await logged(mock, 'both clears', (e) => e.method === 'POST' && e.action === 'delete-worktree');
      assert.deepEqual(removals.map((e) => [e.sessionId, e.status]), [['s-search', 204], ['s-search', 204]], 'the second joined the first, which a second removal of the gone worktree would fail');
      await until('both gone', async () => !(await mock.get('/api/state')).sessions.some((s: { id: string }) => ids.includes(s.id)));

      await mock.post('/mock/clear-hold', {});
      await page.goto(`${mock.url}/wall`);
      await page.click('[data-tile][data-session="s-cart"] button[aria-label="Clear task"]');
      await clear();
      await page.until('s-cart clearing', (id: string) => document.querySelector<HTMLElement>(`[data-tile][data-session="${id}"]`)?.dataset.attention === 'clearing', 's-cart');
      await mock.post('/mock/clear-release', { error: 'Claude did not quit; nothing was deleted' });
      const failed = await page.until('the failed clear on the tile', (id: string) => {
        const t = document.querySelector<HTMLElement>(`[data-tile][data-session="${id}"]`);
        const label = t?.querySelector<HTMLElement>('header [class*="state"]');
        return t && t.dataset.attention !== 'clearing' && label?.textContent === 'Clear failed' && { error: label.dataset.error, text: t.querySelector('p')?.textContent, trash: !!t.querySelector('[data-clear]') };
      }, 's-cart');
      assert.deepEqual(failed, { error: 'true', text: 'Clear task did not finish: Claude did not quit; nothing was deleted', trash: true });
      await shot('clear-failed-tile');
      await page.goto(`${mock.url}/s/s-cart/overview`);
      const shown = await page.until('the failure on the task page', () => document.querySelector('#task-sheet [data-clear-error]')?.textContent);
      assert.match(shown, /Clear task did not finish\. Claude did not quit; nothing was deleted/);
      await page.click('#task-sheet [data-clear-error] button', 'Dismiss');
      await page.until('the failure gone', () => !document.querySelector('#task-sheet [data-clear-error]'));
      assert.equal((await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === 's-cart').clearError, null);
    },
  },
  {
    name: 'P4.9.conversation Conversation, the third tab, shows each prompt with its pictures and Claude\'s reply to it with the artifacts it made, oldest first, earlier conversations before a /clear line; a picture grows on a click and an artifact opens in Artifacts; a prompt and a reply copy whole, as written, from a button in their heading; it reads the transcript again after a new reply; 3 comes back to it',
    async run({ page, mock, shot }) {
      const log = () => {
        const tab = document.querySelector('#task-sheet [role="tab"][aria-selected="true"]')?.textContent;
        const tabs = [...document.querySelectorAll('#task-sheet [role="tab"]')].map((t) => t.textContent);
        const items = [...document.querySelectorAll<HTMLElement>('#task-sheet article')].map((a) => ({
          prompt: a.querySelector<HTMLElement>('[data-prompt] p')!.innerText,
          images: [...a.querySelectorAll<HTMLImageElement>('[data-prompt] img')].filter((i) => i.complete && i.naturalWidth > 0).length,
          reply: a.querySelector<HTMLElement>('[data-reply]:is(p), [data-reply] > :not(h3)')!.innerText.trim(),
          artifacts: [...a.querySelectorAll('button strong')].map((s) => s.textContent),
        }));
        return items.length && items[2]?.images ? { tab, tabs, items, cleared: document.querySelectorAll('#task-sheet section[data-conversation]').length } : null;
      };
      await mock.post('/mock/clear', { id: 's-invoice', conversation: 'c-fresh' });
      const long = Array.from({ length: 30 }, (_, i) => `Checked the rounding of line ${i + 1}.`).join('\n\n');
      await mock.post('/mock/patch', { id: 's-invoice', patch: { lastMessage: long, lastPrompt: `Go on, and tell me when it is done.\n${uploadsDir(await mock.home())}/m2/shot.png` } });
      await openFromWall(page, mock, 's-invoice');
      const quoted = await page.until('the latest reply quoting the prompt with its picture', () => {
        const q = document.querySelector<HTMLElement>('#task-sheet [data-ux-section="latest reply"] [data-prompt]');
        const img = q?.querySelector('img');
        return img?.complete && img.naturalWidth > 0 ? q!.querySelector('p')!.innerText : null;
      });
      assert.equal(quoted, 'Go on, and tell me when it is done.');
      await page.click('#task-sheet [role="tab"]', 'Conversation');
      const shown = await page.until('the conversation with its picture', log);
      assert.deepEqual([shown.tab, shown.tabs], ['Conversation 2', ['Overview 1', 'Conversation 2', 'Diff 7 3', 'Artifacts (1) 4']]);
      assert.equal(shown.cleared, 2);
      assert.deepEqual(shown.items.map((i) => [i.prompt, i.images, i.artifacts]), [
        ['Start with the failing test.', 0, []],
        ['Invoice PDFs are sometimes off by a cent (BILL-91). Find out why, fix it, and get the PR green.', 0, []],
        ['[Image #1] Keep it small; this is what the PDF shows.', 2, []],
        ['Go on, and tell me when it is done.', 1, ['Where the cent goes missing']],
      ]);
      assert.match(shown.items[0].reply, /^The cent goes missing in LineItem\.total\(\)/);
      assert.equal(shown.items[2].reply, 'No reply from Claude: still working, or stopped.');
      assert.match(shown.items[3].reply, /^Checked the rounding of line 1\.[^]*line 30\.$/);
      assert.equal(await page.eval(() => location.pathname), '/s/s-invoice/conversation');
      const lastPrompt = () => {
        const prompt = [...document.querySelectorAll('#task-sheet [data-prompt]')].at(-1)!.getBoundingClientRect().top;
        return Math.round(prompt - document.querySelector('#task-sheet [role="tabpanel"]')!.getBoundingClientRect().top);
      };
      assert.equal(await page.eval(lastPrompt), 18, 'opens on the last prompt');
      await shot('conversation');

      await page.eval(() => {
        const w = window as unknown as { copied: string[] };
        w.copied = [];
        navigator.clipboard.writeText = async (t: string) => void w.copied.push(t);
      });
      await page.eval(() => {
        const articles = [...document.querySelectorAll('#task-sheet article')];
        articles[1].querySelector<HTMLElement>('[data-prompt] h3 button[aria-label="Copy prompt"]')!.click();
        articles[3].querySelector<HTMLElement>('[data-reply] h3 button[aria-label="Copy reply"]')!.click();
      });
      await page.until('both marked Copied', () => [...document.querySelectorAll('#task-sheet h3 button[data-copied]')].map((b) => b.getAttribute('data-tip')).join() === 'Copied,Copied');
      const copied = await page.eval(() => (window as unknown as { copied: string[] }).copied);
      assert.deepEqual(copied, ['Invoice PDFs are sometimes off by a cent (BILL-91). Find out why, fix it, and get the PR green.', long]);
      assert.equal(await page.eval(() => document.querySelector('#task-sheet article [data-prompt] p')!.closest('article')!.querySelector('[data-reply] h3')!.textContent), 'Claude', 'the button adds no text to its heading');
      await shot('conversation-copied');

      const height = () => document.querySelector<HTMLImageElement>('#task-sheet [data-prompt] img')!.getBoundingClientRect().height;
      const small = await page.eval(height);
      await page.click('#task-sheet [data-prompt] button:has(img)');
      await page.until('the picture larger', (h: number) => document.querySelector<HTMLImageElement>('#task-sheet [data-prompt] img')!.getBoundingClientRect().height > h, small);

      await mock.post('/mock/patch', { id: 's-invoice', patch: { lastMessage: 'Checks are green.' } });
      await page.until('the new reply', () => [...document.querySelectorAll<HTMLElement>('#task-sheet article')].at(-1)?.innerText.includes('Checks are green.'));

      await page.click('#task-sheet article button', 'Where the cent goes missing');
      await page.until('the artifact', () => location.pathname === '/s/s-invoice/artifacts/art-invoice-1');
      await page.key('2');
      await page.until('the conversation again', () => location.pathname === '/s/s-invoice/conversation' && !!document.querySelector('#task-sheet article'));
    },
  },
  {
    name: 'P4.9.conversation-long a long transcript opens on its last prompt with the replies near it drawn as Markdown and the far ones as written; scrolled up, the earliest is drawn as Markdown too, and the last prompt stays where it was until then',
    async run({ page, mock }) {
      const now = Date.now();
      const history = Array.from({ length: 80 }, (_, i) => ({ id: `c-old-${i}`, lastMessage: `Reply ${i} with **bold** and \`code\`.`, until: now - (80 - i) * 60_000 }));
      const long = Array.from({ length: 30 }, (_, i) => `Checked the rounding of line ${i + 1}.`).join('\n\n');
      await mock.post('/mock/patch', { id: 's-invoice', patch: { history, lastMessage: long } });
      await openFromWall(page, mock, 's-invoice');
      await page.click('#task-sheet [role="tab"]', 'Conversation');
      await page.until('the conversation', () => document.querySelectorAll('#task-sheet article[data-exchange]').length === 83);
      const drawn = () => [...document.querySelectorAll('#task-sheet article[data-exchange]')].map((a) => !!a.querySelector('[data-reply] strong'));
      const first = await page.eval(drawn);
      assert.equal(first[79], true, 'a reply in view is drawn as Markdown');
      assert.equal(first[0], false, 'the far first reply was drawn as Markdown too');
      assert.ok(first.filter(Boolean).length < 40, `${first.filter(Boolean).length} replies drawn at once`);
      const lastPrompt = () => {
        const prompt = [...document.querySelectorAll('#task-sheet [data-prompt]')].at(-1)!.getBoundingClientRect().top;
        return Math.round(prompt - document.querySelector('#task-sheet [role="tabpanel"]')!.getBoundingClientRect().top);
      };
      const at = await page.eval(lastPrompt);
      await sleep(300);
      assert.deepEqual([at, await page.eval(lastPrompt)], [18, 18], 'the last prompt moved as the replies near it were drawn');
      assert.match(await page.eval(() => document.querySelector<HTMLElement>('#task-sheet article[data-exchange] [data-reply] > div')!.textContent), /^Reply 0 with \*\*bold\*\* and `code`\.$/);
      await page.eval(() => document.querySelector('#task-sheet [role="tabpanel"] > div')!.scrollTo({ top: 0 }));
      await page.until('the first reply drawn as Markdown', () => !!document.querySelector('#task-sheet article[data-exchange]')?.querySelector('[data-reply] strong'));
      assert.equal(await page.eval(() => document.querySelector<HTMLElement>('#task-sheet article[data-exchange] [data-reply] > div')!.innerText.trim()), 'Reply 0 with bold and code.');
    },
  },
];
