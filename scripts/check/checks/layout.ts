import assert from 'node:assert/strict';
import { sleep, until } from '../cdp.ts';
import {
  actions, animations, approveLoss, decision, decisionOf, HELD_MS, logged, lowContrast, matches, menuItems, newTaskOnRepo, noDecision, noteAnimations, openDecision,
  openFromWall, openNewTask, openSheetOf, pickerOpen, pillAt, POSTED_MS, reachable, ready, replyIn, settled, sheetOpen, sidewaysScroll, stateOf, still, tiles, toastsOf,
  typeInPrompt, unguarded, withoutBoard, type Check,
} from '../helpers.ts';

// The top bar's Next decision as it reads.
const nextInBar = () => document.querySelector<HTMLElement>('header [data-next-decision]')?.innerText.replace(/\s+/g, ' ').trim() ?? null;

export const layout: Check[] = [
  {
    name: 'P6.menu-outside a click on the top bar while the task\'s ⋯ menu is open closes only the menu; after a click inside the task closed the menu, Esc still goes back to the Wall; the task is a page, so a click on the top bar with no menu open leaves it open',
    async run({ holds, page, mock, shot }) {
      const layers = () => ({ menu: !!document.querySelector('[popover="auto"]:popover-open'), sheet: !!document.querySelector('#task-sheet'), path: location.pathname });
      const stays = async () => matches(await page.eval(layers), { menu: false, sheet: true, path: '/s/s-invoice/overview' });
      const menu = async () => {
        await page.click('#task-sheet button[aria-label="Session actions"]');
        await page.until('the ⋯ menu', () => !!document.querySelector('[popover="auto"]:popover-open'));
      };
      await openFromWall(page, mock, 's-invoice');
      await page.until('the sheet to settle', settled);
      await menu();
      await page.pointAt(12, 12, true);
      await page.until('the menu to close', () => !document.querySelector('[popover="auto"]:popover-open'));
      await holds('the sheet to stay', 400, stays);
      await shot('sheet-after-menu-outside');

      await menu();
      await page.click('#task-sheet header [data-attention]');
      await page.until('the menu to close', () => !document.querySelector('[popover="auto"]:popover-open'));
      await holds('the sheet to stay', 400, stays);
      await page.key('Escape');
      await page.until('Esc to close the sheet', () => !document.querySelector('#task-sheet') && location.pathname === '/');

      await page.click('[data-tile][data-session="s-invoice"] a');
      await page.until('the sheet again', sheetOpen);
      await page.until('the sheet to settle', settled);
      await page.pointAt(12, 12, true);
      await holds('the sheet to stay', 400, stays);
    },
  },
  {
    name: 'P6.repos-connecting Repos says Connecting… until the first snapshot, and its empty state once the board says there are no repositories',
    scenario: 'norepos',
    expectedErrors: [/WebSocket/],
    async run({ page, mock, shot }) {
      const repos = () => document.querySelector<HTMLDialogElement>('dialog#workspace')?.open && document.querySelector<HTMLElement>('dialog#workspace')!.innerText;
      await withoutBoard(page, async (url) => {
        await page.goto(`${url}/`);
        await page.click('[data-repos]');
        const text = await page.until('Repos', repos);
        assert.match(text, /Connecting…/);
        assert.doesNotMatch(text, /Add a repository or a folder of repositories to begin/);
        await page.until('the dialog to settle', settled);
        await shot('repos-connecting');
      });
      await page.goto(`${mock.url}/`);
      await page.until('the live pill', () => !!document.querySelector('[data-link="live"]'));
      await page.click('[data-repos]');
      const text = await page.until('Repos', repos);
      assert.match(text, /Add a repository or a folder of repositories to begin\./);
      assert.doesNotMatch(text, /Connecting…/);
    },
  },
  {
    name: 'P7.leave Quit Claude and Clear task from a task page\'s ⋯ take the task out of what waits at once: Next decision stops counting it, and nothing says that anything stopped waiting',
    async run({ holds, page, mock }) {
      const confirmable = () => {
        const d = document.querySelector<HTMLDialogElement>('dialog#delete-worktree');
        return !!d?.open && !d.innerText.includes('Checking');
      };
      await openDecision(page, mock, 's-cart');
      assert.equal(await page.eval(nextInBar), 'Next decision 2 D');
      await page.click('#task-sheet header button[aria-label="Session actions"]');
      await page.until('the menu', menuItems);
      await page.click(':popover-open button', 'Quit Claude');
      await page.until('the decision to go', noDecision, 's-cart');
      const [quit] = await logged(mock, 'the quit', (e) => e.action === 'quit');
      assert.deepEqual([quit.sessionId, quit.status], ['s-cart', 204]);

      await openDecision(page, mock, 's-hooks');
      assert.equal(await page.eval(nextInBar), 'Next decision 1 D', 'the ended s-cart still counts');
      await page.click('#task-sheet header button[aria-label="Session actions"]');
      await page.until('the menu', menuItems);
      await page.click(':popover-open button', 'Clear task');
      await page.until('the delete dialog', confirmable);
      await approveLoss(page);
      await page.click('dialog#delete-worktree button', 'Clear task');
      await page.until('the Wall', () => location.pathname === '/' && !document.querySelector('#task-sheet'));
      const [deleted] = await logged(mock, 'the deletion', (e) => e.method === 'POST' && e.action === 'delete-worktree');
      assert.deepEqual([deleted.sessionId, deleted.status], ['s-hooks', 204]);
      await holds('s-cart and s-hooks out of what waits, with no toast', 600, async () => matches([
        await page.eval(nextInBar),
        await page.eval(() => [...document.querySelectorAll<HTMLElement>('[data-tile][data-attention="decide"]')].map((t) => t.dataset.session)),
        await page.eval(toastsOf, 'info'), await page.eval(toastsOf, 'error'),
      ], ['Next decision 1 D', ['s-group'], null, null]));
    },
  },
  {
    name: 'P7.archive-stays an archive from a tile\'s ⋯ shows at once and stays: a snapshot pushed before the server has stored it does not bring the tile back among the live ones for a moment',
    async run({ holds, page, mock }) {
      const live = '[data-tile][data-session="s-reviews"]:not([data-archived])';
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      await mock.post('/mock/delay', { ms: 1500 });
      await page.click(`${live} button[aria-label="Session actions"]`);
      await page.until('the menu', menuItems);
      await page.click(':popover-open button', 'Archive');
      await page.until('s-reviews to leave the live tiles', (sel: string) => !document.querySelector(sel), live);
      await page.eval((sel: string) => {
        const w = window as unknown as { e2eBack: boolean };
        w.e2eBack = false;
        new MutationObserver(() => {
          if (document.querySelector(sel)) w.e2eBack = true;
        }).observe(document.body, { subtree: true, childList: true, attributes: true });
      }, live);
      await mock.post('/mock/patch', { id: 's-invoice', patch: { activity: { step: 'Bash: pnpm test invoices --run --reporter=dot' } } });
      await page.until('that snapshot', () => !!document.querySelector('[data-tile][data-session="s-invoice"]')?.textContent?.includes('--reporter=dot'));
      const [archived] = await logged(mock, 'the archive', (e) => e.action === 'archive', 4000);
      assert.deepEqual([archived.sessionId, archived.status], ['s-reviews', 204]);
      await holds('s-reviews to stay archived', 300, async () => matches([await page.eval(() => (window as unknown as { e2eBack: boolean }).e2eBack), await page.eval((sel: string) => !!document.querySelector(sel), live)], [false, false]));
      assert.equal((await stateOf(mock, 's-reviews')).archived, true);
    },
  },
  {
    name: 'P7.arrival-waits typing in New task over the Wall at rest: a decision that arrives meanwhile shows its tile and Next decision under the dialog, and the prompt keeps focus and text',
    scenario: 'zero',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the Wall at rest', () => document.querySelector('main h1')?.textContent === 'All caught up.');
      await openNewTask(page);
      await page.type('Add retries');
      await mock.post('/mock/add', { template: 'ask', id: 's-new' });
      await page.until('the tile and Next decision', () => !!document.querySelector('[data-tile][data-session="s-new"]') && !!document.querySelector('header [data-next-decision]'));
      assert.deepEqual(await page.eval(() => [document.querySelector<HTMLTextAreaElement>('dialog#new-task textarea')?.value, document.activeElement === document.querySelector('dialog#new-task textarea')]), ['Add retries', true]);
    },
  },
  {
    name: 'P7.new-task-fade Esc closes New task over the Wall and takes focus out of its prompt at once, so a key typed while the dialog fades out does not land in it',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      await page.key('n');
      await page.until('New task, its repository focused', newTaskOnRepo);
      await typeInPrompt(page);
      await page.type('Fix');
      await page.key('Escape');
      await page.key('q');
      await page.until('New task to close and let go of focus', () => !document.querySelector<HTMLDialogElement>('#new-task')!.open && !document.activeElement?.closest('#new-task'));
      assert.deepEqual(await page.eval(() => ({
        open: document.querySelector<HTMLDialogElement>('#new-task')!.open,
        prompt: document.querySelector<HTMLTextAreaElement>('#new-task textarea')!.value,
        inside: !!document.activeElement?.closest('#new-task'),
      })), { open: false, prompt: 'Fix', inside: false });
    },
  },
  {
    name: 'P7.picker-outside a click beside New task while its repository picker is open closes only the picker; the next click beside it closes the dialog',
    async run({ holds, page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      await page.key('n');
      await page.until('New task', () => !!document.querySelector('#new-task:modal'));
      await page.until('the dialog to settle', settled);
      await page.click('#new-task button[aria-haspopup="listbox"]');
      await page.until('the picker', pickerOpen);
      await page.pointAt(24, 860, true);
      await page.until('the picker to close', () => !document.querySelector('#new-task [data-repo-picker]:popover-open'));
      await holds('New task to stay open', 300, () => page.eval(() => !!document.querySelector('#new-task:modal')));
      await page.pointAt(24, 860, true);
      await page.until('the dialog to close', () => !document.querySelector('#new-task[open]'));
    },
  },
  {
    name: 'P7.phone-toast narrow window: the undo toast of a message sent from a sheet sits at the bottom of the window, clear of the sheet\'s head, and takes a click',
    narrow: true,
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-invoice/overview`);
      await page.until('the sheet', sheetOpen);
      await page.click('#task-sheet textarea');
      await page.type('Also round the tax lines');
      await page.key('Enter');
      const [toast] = await page.until('the undo toast', toastsOf, 'undo');
      const at = await page.eval(() => {
        const t = document.querySelector('[data-toast][data-kind="undo"]')!.getBoundingClientRect();
        const head = document.querySelector('#task-sheet header')!.getBoundingClientRect();
        return { clear: t.top >= head.bottom || t.bottom <= head.top, bottom: innerHeight - t.bottom, inside: t.left >= 0 && t.right <= innerWidth };
      });
      assert.deepEqual({ ...at, bottom: at.bottom <= 40, hit: toast.hit }, { clear: true, bottom: true, inside: true, hit: true });
      await shot('phone-sheet-toast');
      await page.click('[data-toast][data-kind="undo"] button', 'Undo');
      await page.until('the message back in the reply box', () => document.querySelector<HTMLTextAreaElement>('#task-sheet textarea')?.value === 'Also round the tax lines');
    },
  },
  {
    name: 'P7.reply-hint with the decision\'s reply box and its command list open, the hint line under the box shows whole in the task page',
    async run({ page, mock, shot }) {
      await openDecision(page, mock);
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-decision] textarea'));
      await page.type('/re');
      await page.until('the command list', () => document.querySelectorAll('[data-decision] [role="option"]').length > 0);
      await page.until('the command list to settle', settled);
      await page.eval(() => document.querySelector('[data-decision] textarea')!.closest('section')!.scrollIntoView({ block: 'nearest' }));
      await page.until('the hint line whole', () => {
        const p = [...document.querySelectorAll<HTMLElement>('[data-decision] section p')].find((x) => x.textContent?.startsWith('Enter sends'));
        if (!p) return false;
        const r = p.getBoundingClientRect();
        const panel = document.querySelector('#task-sheet [role="tabpanel"]')!.getBoundingClientRect();
        return r.height > 0 && r.top >= panel.top && r.bottom <= Math.min(panel.bottom, innerHeight) + 1;
      });
      await shot('task-composer-commands');
    },
  },
  {
    name: 'P7.phone-task narrow window: the task page of every kind of task waiting is one column with no sideways scroll, a menu\'s questions one under the other, and a decision\'s main button in reach; W brings the reply box whole into view with its hint line',
    narrow: true,
    async run({ page, mock, shot }) {
      const stacked = () => {
        const rs = [...document.querySelectorAll('[data-decision] section[role="group"]')].map((e) => e.getBoundingClientRect());
        return rs.every((r, i) => i === 0 || (Math.abs(r.left - rs[0].left) < 1 && r.top >= rs[i - 1].bottom - 1));
      };
      for (const id of ['s-cart', 's-hooks', 's-group', 's-astro', 's-reviews']) {
        await openSheetOf(page, mock, id);
        await page.until('its Overview', () => !!document.querySelector('#task-sheet [role="tabpanel"] section'));
        await page.until('the page to settle', still);
        assert.deepEqual(await page.eval(sidewaysScroll), [], id);
        if (await page.eval(decision)) {
          assert.equal(await page.eval(stacked), true, `${id}: the menu's questions stand side by side`);
          await page.until(`${id}: the main button in reach`, reachable, '[data-decision] [data-primary]', '');
        }
        if (id === 's-cart') await shot('phone-ask');
        if (id === 's-hooks') await shot('phone-menu');
        if (id === 's-reviews') await shot('phone-your-turn');
      }
      await openDecision(page, mock, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-decision] textarea'));
      await page.until('the reply box to settle', settled);
      const reply = await page.eval(() => {
        const hint = [...document.querySelectorAll('[data-decision] section p')].find((p) => p.textContent?.startsWith('Enter sends'))!.getBoundingClientRect();
        const box = document.querySelector('[data-decision] textarea')!.getBoundingClientRect();
        return { box: box.top >= 0 && box.bottom <= innerHeight, hint: hint.bottom <= innerHeight };
      });
      assert.deepEqual(reply, { box: true, hint: true });
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await shot('phone-reply');
    },
  },
  {
    name: 'P7.phone-sideways narrow window: nothing scrolls sideways on the Wall, in the sheet\'s tabs, in New task, Repos, Keys, Delete worktree or the ⋯ menu, and each dialog fits the window; only the artifacts list scrolls sideways, by design, and the diff wraps its lines',
    narrow: true,
    async run({ page, mock, shot }) {
      const inside = (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return r.left >= -1 && r.right <= innerWidth + 1;
      };
      const sideways = async (where: string, byDesign?: RegExp) =>
        assert.deepEqual((await page.eval(sidewaysScroll)).filter((s) => !byDesign?.test(s)), [], where);
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      await sideways('the Wall');
      await shot('phone-wall');
      for (const tab of ['diff', 'artifacts', 'overview']) {
        await page.goto(`${mock.url}/s/s-cart/${tab}`);
        await page.until('the sheet', sheetOpen);
        await page.until('the sheet to settle', settled);
        if (tab === 'diff') await page.until('the diff', () => document.querySelectorAll('section[data-file] diffs-container').length === 12);
        await sideways(`the sheet's ${tab}`, tab === 'artifacts' ? /^div\.\w+_list$/ : undefined);
        assert.equal(await page.eval(inside, '#task-sheet'), true);
        await shot(`phone-sheet-${tab}`);
      }
      await page.click('#task-sheet header button[aria-label="Session actions"]');
      await page.until('the menu', menuItems);
      await sideways('the ⋯ menu');
      assert.equal(await page.eval(inside, ':popover-open'), true, 'the ⋯ menu');
      await page.click(':popover-open button', 'Clear task');
      await page.until('the delete dialog', () => !!document.querySelector('dialog#delete-worktree li'));
      await page.until('the dialog to settle', settled);
      await sideways('Delete worktree');
      assert.equal(await page.eval(inside, 'dialog#delete-worktree'), true);
      await shot('phone-delete');
      await page.key('Escape');

      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      await page.key('n');
      await page.until('New task', () => !!document.querySelector('#new-task:modal'));
      await page.until('the dialog to settle', settled);
      await sideways('New task');
      assert.equal(await page.eval(inside, '#new-task'), true);
      await shot('phone-new-task');
      await page.key('Escape');
      await page.until('New task to close', () => !document.querySelector('#new-task[open]'));
      await page.click('button[data-repos]');
      await page.until('Repos', () => !!document.querySelector('#workspace:modal section'));
      await page.until('the dialog to settle', settled);
      await sideways('Repos');
      assert.equal(await page.eval(inside, '#workspace'), true);
      await shot('phone-repos');
      await page.key('Escape');
      await page.until('Repos to close', () => !document.querySelector('#workspace[open]'));
      await page.key('?');
      await page.until('Keys', () => !!document.querySelector('#keys:modal'));
      await page.until('the dialog to settle', settled);
      await sideways('Keys');
      assert.equal(await page.eval(inside, '#keys'), true);
    },
  },
  {
    name: 'P7.reduced-motion with reduced motion going from decision to decision runs no animation longer than 10 ms: Next decision, D, an answer, its Undo and the answer again with the way on to the next',
    clock: 'fast',
    motion: 'reduce',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      await page.until('the page to settle', still);
      await page.eval(noteAnimations);
      await page.click('header [data-next-decision]');
      await ready(page, 's-cart');
      await page.key('d');
      await ready(page, 's-hooks');
      await page.key('Escape');
      await page.until('the Wall', () => !document.querySelector('#task-sheet'));
      await page.click('header [data-next-decision]');
      await ready(page, 's-cart');
      await page.key('Enter');
      await page.until('the decision to go', noDecision, 's-cart');
      await page.key('z');
      await ready(page, 's-cart');
      await page.key('Enter');
      await page.until('the way on', () => !!document.querySelector('#task-sheet [data-next-after]'));
      await sleep(300);
      const all = await page.eval(animations);
      assert.ok(all.length > 0, 'no animation was noted');
      assert.deepEqual(all.filter((a) => !(a.end <= 10)).map((a) => a.text), []);
    },
  },
  {
    name: 'P7.contrast-decisions every text on a task page with a decision and in the top bar reads at 4.5:1 or more: an ask with Next decision, its reply box and command list, a menu, another ask, Needs focus, Your turn, a send held, a refusal marked Not sent and the way on to the next decision',
    expectedErrors: [/status of 400/],
    async run({ themes, page, mock }) {
      const fails: string[] = [];
      // A decision that just came up shows its main button dimmed for 0.9 s; each step is read once that is over.
      const audit = async (where: string) => {
        await page.until('the guard to end', unguarded);
        await page.until('the page to settle', still);
        await themes(async (scheme) => {
          fails.push(...(await page.eval(lowContrast, 4.5)).map((f) => `${where} (${scheme}): ${f}`));
        });
      };
      await openDecision(page, mock, 's-cart');
      await audit('ask');
      await page.key('w');
      await page.type('/re');
      await page.until('the command list', () => document.querySelectorAll('[data-decision] [role="option"]').length > 0);
      await audit('reply box');
      await page.key('Escape');
      await page.key('Backspace');
      await page.key('Backspace');
      await page.key('Backspace');
      await openDecision(page, mock, 's-hooks');
      await audit('menu');
      await openDecision(page, mock, 's-group');
      await audit('another ask');
      for (const id of ['s-astro', 's-reviews']) {
        await openSheetOf(page, mock, id);
        await page.until('its Overview', () => !!document.querySelector('#task-sheet [role="tabpanel"] section'));
        await audit(id === 's-astro' ? 'Needs focus' : 'Your turn');
      }
      await openDecision(page, mock, 's-cart');
      await mock.post('/mock/fail', { error: 'this question is no longer open', code: 'stale' });
      await page.key('Enter');
      await page.until('the undo toast', toastsOf, 'undo');
      await audit('a send held, with the way on');
      await page.until('the refusal', toastsOf, 'error');
      await page.until('the decision marked Not sent', () => !!document.querySelector('[data-decision] [data-not-sent]'));
      await audit('refused');
      assert.deepEqual(fails, []);
    },
  },
  {
    name: 'P7.contrast-wall-sheet every text on the Wall, archived tiles included, and in the sheet\'s Overview (working, decision, Needs focus), Diff and Artifacts tabs and its ⋯ menu reads at 4.5:1 or more',
    async run({ themes, page, mock }) {
      const fails: string[] = [];
      const audit = async (where: string) => {
        await page.until('the page to settle', settled);
        await themes(async (scheme) => {
          fails.push(...(await page.eval(lowContrast, 4.5)).map((f) => `${where} (${scheme}): ${f}`));
        });
      };
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      await page.click('details summary', 'Archived');
      await page.until('the archived tile', () => document.querySelector('[data-tile][data-archived]')?.checkVisibility());
      await audit('Wall');
      for (const id of ['s-invoice', 's-cart', 's-astro']) {
        await page.goto(`${mock.url}/s/${id}/overview`);
        await page.until('the sheet', sheetOpen);
        await page.until('its Overview', () => !!document.querySelector('#task-sheet [role="tabpanel"] section'));
        await audit(`Overview of ${id}`);
      }
      await page.goto(`${mock.url}/s/s-cart/diff`);
      await page.until('the diff', () => document.querySelectorAll('section[data-file] diffs-container').length === 12);
      await audit('Diff');
      await page.goto(`${mock.url}/s/s-cart/artifacts`);
      await page.until('the artifact', () => !!document.querySelector('#task-sheet iframe'));
      await audit('Artifacts');
      await page.click('#task-sheet header button[aria-label="Session actions"]');
      await page.until('the menu', menuItems);
      await audit('the sheet\'s ⋯ menu');
      assert.deepEqual(fails, []);
    },
  },
  {
    name: 'P7.contrast-dialogs every text in New task (its options and picker open), Repos (settings, a conversation list and a removal open), Keys, Delete worktree, the toasts in a sheet and the top bar\'s pills reads at 4.5:1 or more',
    expectedErrors: [/status of 400/, /Finder is not available/, /WebSocket/, /ERR_CONNECTION/],
    async run({ themes, page, mock }) {
      const fails: string[] = [];
      const audit = async (where: string) => {
        await page.until('the page to settle', settled);
        await themes(async (scheme) => {
          fails.push(...(await page.eval(lowContrast, 4.5)).map((f) => `${where} (${scheme}): ${f}`));
        });
      };
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      await page.key('n');
      await page.until('New task', () => !!document.querySelector('#new-task:modal'));
      await page.type('Add retries to the webhook worker');
      await audit('New task');
      await page.click('#new-task button[aria-haspopup="listbox"]');
      await page.until('the picker', pickerOpen);
      await audit('New task, its picker');
      await page.key('Escape');
      await page.key('Escape');
      await page.until('New task to close', () => !document.querySelector('#new-task[open]'));

      await page.click('button[data-repos]');
      await page.until('Repos', () => !!document.querySelector('#workspace:modal section'));
      await page.click('#workspace button', 'Settings');
      await page.click('#workspace details summary', 'conversation');
      await page.click('#workspace [data-worktree] button', 'Remove');
      await audit('Repos');
      await page.key('Escape');
      await page.until('Repos to close', () => !document.querySelector('#workspace[open]'));

      await page.key('?');
      await page.until('Keys', () => !!document.querySelector('#keys:modal'));
      await audit('Keys');
      await page.key('Escape');

      await page.click('[data-tile][data-session="s-cart"] button[aria-label="Session actions"]');
      await page.click(':popover-open button', 'Clear task');
      await page.until('the delete dialog', () => !!document.querySelector('dialog#delete-worktree li'));
      await audit('Delete worktree');
      await page.key('Escape');
      await page.until('the dialog to close', () => !document.querySelector('dialog#delete-worktree[open]'));

      await page.goto(`${mock.url}/s/s-invoice/overview`);
      await page.until('the sheet', sheetOpen);
      await page.click('#task-sheet textarea');
      await page.type('Also round the tax lines');
      await page.key('Enter');
      await page.until('the undo toast', toastsOf, 'undo');
      await mock.post('/mock/fail', { error: 'Finder is not available' });
      await page.click('#task-sheet header button[aria-label="Session actions"]');
      await page.click(':popover-open button', 'Open in Finder');
      await page.until('the error toast', toastsOf, 'error');
      await audit('toasts in the sheet');
      await page.key('Escape');

      const build = '/assets/index-contrast.js';
      await page.eval((build: string) => {
        const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')!.src;
        sessionStorage.setItem('pitwall:reloaded-for', `${entry} ${new URL(build, location.href).href}`);
      }, build);
      await mock.post('/mock/ui-entry', { src: build });
      await page.until('the reload pill', () => !!document.querySelector('[data-new-version]'));
      await audit('the reload pill');
      await mock.post('/mock/ui-entry', { src: null });
      await mock.post('/mock/drop', { ms: 3000 });
      await page.until('Reconnecting…', pillAt, 'reconnecting');
      await audit('reconnecting');
      await page.until('Live again', pillAt, 'live');
      assert.deepEqual(fails, []);
    },
  },
  {
    name: 'P7.send-undo two sends from two task pages each hold a toast of their own, and each Undo takes back its own: s-cart\'s option with its note comes back on its page with the note in the reply box, while s-hooks\'s menu answer goes out 5 s after its press, once',
    async run({ holds, page, mock, shot }) {
      await openDecision(page, mock, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-decision] textarea'));
      await page.type('only if stock allows');
      await page.click('[data-decision] [data-option="2"]');
      await page.until('the decision to go', noDecision, 's-cart');
      await page.click('#task-sheet [data-next-after] button');
      await ready(page, 's-hooks');
      await page.click('[data-decision] [data-option="1"]');
      await page.click('[data-decision] [data-option="4"]');
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.key('Enter');
      const pressed = Date.now();
      await page.until('the decision to go', noDecision, 's-hooks');
      const held = await page.until('two undo toasts', () => {
        const t = [...document.querySelectorAll<HTMLElement>('[data-toast][data-kind="undo"]')].map((x) => x.innerText.split('\n')[0]);
        return t.length === 2 && t;
      });
      assert.ok(held.some((t) => t.startsWith('Sending: “Keep the account cart”')), held.join(' | '));
      assert.ok(held.some((t) => t.startsWith('Sending: “Backoff: Exponential, 5 tries')), held.join(' | '));
      await shot('two-sends');
      await page.eval(() => [...document.querySelectorAll<HTMLElement>('[data-toast][data-kind="undo"]')].find((t) => t.innerText.includes('Keep the account cart'))!.querySelector<HTMLButtonElement>('button')!.click());
      // In the page, as a load would send what is held.
      await page.eval(() => void navigation.navigate('/s/s-cart/overview'));
      await page.until('s-cart\'s decision back', decisionOf, 's-cart');
      assert.deepEqual({ ...(await page.eval(replyIn, '[data-decision]')), focused: undefined }, { value: 'only if stock allows', files: [], focused: undefined });
      await holds('the menu answer to wait its 5 s', Math.max(0, 4000 - (Date.now() - pressed)), async () => !(await actions(mock)).length);
      await until('the menu answer', async () => (await actions(mock)).length > 0, POSTED_MS);
      assert.ok(Date.now() - pressed >= 4500, 'the send went out before its 5 s');
      assert.deepEqual((await actions(mock)).map((e) => [e.action, e.sessionId, e.status]), [['answer-menu', 's-hooks', 204]]);
    },
  },
  {
    name: 'P7.keyboard with no pointer at all: D opens the next decision, ⏎ answers and Z takes it back, D goes on; 3 the Diff, J a file, Esc all files and Esc the Wall; N New task, typing and Esc; ? Keys and Esc',
    clock: 'fast',
    async run({ holds, page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      await page.eval(() => {
        const w = window as unknown as { e2ePointer: number };
        w.e2ePointer = 0;
        for (const type of ['pointerdown', 'mousedown']) addEventListener(type, () => w.e2ePointer++, true);
      });
      await page.until('Next decision', nextInBar);
      await page.key('d');
      await ready(page, 's-cart');
      await page.key('Enter');
      await page.until('the decision to go', noDecision, 's-cart');
      await page.key('z');
      await ready(page, 's-cart');
      await page.key('d');
      await ready(page, 's-hooks');
      await page.key('3');
      await page.until('the Diff', () => location.pathname === '/s/s-hooks/diff' && document.querySelectorAll('section[data-file] diffs-container').length > 0);
      const files = await page.eval(() => document.querySelectorAll('section[data-file]').length);
      await page.key('j');
      await page.until('one file, whole', () => document.querySelectorAll('section[data-file]').length === 1 && !!document.querySelector('[data-theme="dark"] > div')?.textContent?.includes('← All files'));
      await page.key('Escape');
      await page.until('all files again', (n: number) => document.querySelectorAll('section[data-file]').length === n, files);
      assert.equal(await page.eval(sheetOpen), true);
      await page.key('Escape');
      await page.until('the Wall', () => location.pathname === '/' && !document.querySelector('#task-sheet') && document.querySelectorAll('[data-tile]').length > 0);

      await page.key('n');
      await page.until('New task, its repository focused', newTaskOnRepo);
      for (let i = 0; i < 10 && !(await page.eval(() => document.activeElement?.matches('dialog#new-task textarea'))); i++) await page.key('Tab');
      assert.equal(await page.eval(() => document.activeElement?.matches('dialog#new-task textarea')), true, 'Tab reaches the prompt');
      for (const ch of 'fix the login') await page.key(ch);
      await page.key('Escape');
      await page.until('New task to close', () => !document.querySelector('dialog#new-task[open]') && !document.activeElement?.closest('dialog#new-task'));
      assert.equal(await page.eval(() => document.querySelector<HTMLTextAreaElement>('dialog#new-task textarea')!.value), 'fix the login');

      await page.key('?');
      await page.until('Keys', () => !!document.querySelector('#keys:modal'));
      await page.key('Escape');
      await page.until('Keys to close', () => !document.querySelector('#keys[open]'));
      assert.equal(await page.eval(() => (window as unknown as { e2ePointer: number }).e2ePointer), 0);
      await holds('the answer taken back to stay back', HELD_MS, async () => !(await actions(mock)).length);
    },
  },
  {
    name: 'P7.contrast-volume with 45 tasks waiting every text on the Wall and the top bar\'s Next decision reads at 4.5:1 or more too',
    scenario: 'volume45',
    async run({ themes, page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile][data-attention="decide"]').length === 30);
      assert.equal(await page.eval(nextInBar), 'Next decision 30 D');
      await page.until('the page to settle', still);
      await themes(async (scheme) => assert.deepEqual(await page.eval(lowContrast, 4.5), [], scheme));
    },
  },
];
