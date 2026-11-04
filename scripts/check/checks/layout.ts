import assert from 'node:assert/strict';
import { sleep } from '../cdp.ts';
import { actions, animations, approveLoss, dealt, docked, dockState, frontIs, HELD_MS, hoverCard, logged, lowContrast, matches, menuItems, narrowCard, newTaskOnRepo, noteAnimations, openNewTask, openQueue, pickerOpen, pillAt, primaryAtEnds, ready, replyIn, settled, sheetOpen, sidewaysScroll, stateOf, still, tiles, toastsOf, typeInPrompt, unguarded, watchDeals, type Check } from '../helpers.ts';

export const layout: Check[] = [
  {
    name: 'P7.leave-deals Quit Claude and Delete worktree from the card\'s ⋯ deal the card out sideways, as Archive does; the card after it comes up, with no word that anything stopped waiting',
    async run({ holds, page, mock }) {
      const confirmable = () => {
        const d = document.querySelector<HTMLDialogElement>('dialog#delete-worktree');
        return !!d?.open && !d.innerText.includes('Checking');
      };
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.eval(watchDeals);
      await page.click('[data-card] button[aria-label="Session actions"]');
      await page.until('the menu', menuItems);
      await page.click(':popover-open button', 'Quit Claude');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.deepEqual(await page.eval(dealt), ['side']);
      const [quit] = await logged(mock, 'the quit', (e) => e.action === 'quit');
      assert.deepEqual([quit.sessionId, quit.status], ['s-cart', 204]);

      await ready(page, 's-hooks');
      await page.click('[data-card] button[aria-label="Session actions"]');
      await page.until('the menu', menuItems);
      await page.click(':popover-open button', 'Clear task');
      await page.until('the delete dialog', confirmable);
      await approveLoss(page);
      await page.click('dialog#delete-worktree button', 'Clear task');
      await page.until('s-group at the front', frontIs, 's-group');
      assert.deepEqual(await page.eval(dealt), ['side', 'side']);
      const [deleted] = await logged(mock, 'the deletion', (e) => e.method === 'POST' && e.action === 'delete-worktree');
      assert.deepEqual([deleted.sessionId, deleted.status], ['s-hooks', 204]);
      await holds('s-cart and s-hooks to stay gone, with no toast', 600, async () => matches([
        await page.eval(() => !!document.querySelector('[data-session="s-cart"]:is([data-segment], [data-peek]), [data-session="s-hooks"]:is([data-segment], [data-peek])')),
        await page.eval(toastsOf, 'info'), await page.eval(toastsOf, 'error'),
      ], [false, null, null]));
    },
  },
  {
    name: 'P7.archive-stays an archive shows at once and stays: a snapshot pushed before the server has stored it does not bring the card back for a moment',
    async run({ holds, page, mock }) {
      await openQueue(page, mock);
      await page.click('[data-segment][data-session="s-reviews"]');
      await ready(page, 's-reviews');
      await mock.post('/mock/delay', { ms: 1500 });
      await page.key('x');
      const shownAnywhere = () => !!document.querySelector('[data-session="s-reviews"]:is([data-segment], [data-peek], [data-card])');
      await page.until('s-reviews to leave', () => !document.querySelector('[data-session="s-reviews"]:is([data-segment], [data-peek], [data-card])'));
      await page.eval(() => {
        const w = window as unknown as { e2eBack: boolean };
        w.e2eBack = false;
        new MutationObserver(() => {
          if (document.querySelector('[data-session="s-reviews"]:is([data-segment], [data-peek], [data-card])')) w.e2eBack = true;
        }).observe(document.body, { subtree: true, childList: true, attributes: true });
      });
      await mock.post('/mock/patch', { id: 's-invoice', patch: { activity: { step: 'Bash: pnpm test invoices --run --reporter=dot' } } });
      await page.until('that snapshot', () => !!document.querySelector('[data-capsule][data-session="s-invoice"]')?.textContent?.includes('--reporter=dot'));
      const [archived] = await logged(mock, 'the archive', (e) => e.action === 'archive', 4000);
      assert.deepEqual([archived.sessionId, archived.status], ['s-reviews', 204]);
      await holds('s-reviews to stay archived', 300, async () => matches([await page.eval(() => (window as unknown as { e2eBack: boolean }).e2eBack), await page.eval(shownAnywhere)], [false, false]));
      assert.equal((await stateOf(mock, 's-reviews')).archived, true);
    },
  },
  {
    name: 'P7.skip-ends-wait a click on Skip that ends a wait for typing brings up the card that waited and skips nothing; the next click skips',
    async run({ holds, page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('Let me think');
      await mock.post('/mock/patch', { id: 's-cart', patch: { question: null, status: 'working', activity: { step: 'Edit src/cart/mergeCarts.ts', since: Date.now() } } });
      await page.until('s-cart to leave the deck', () => !document.querySelector('[data-segment][data-session="s-cart"]'));
      assert.equal(await page.eval(() => document.querySelector<HTMLElement>('[data-card]')?.dataset.session), 's-cart', 'the card did not wait for the typing');
      await page.eval(watchDeals);
      await page.click('main button[aria-label="Skip to the next card"]');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await holds('the click to skip nothing', 700, async () => matches([await page.eval(() => document.querySelector<HTMLElement>('[data-card]')?.dataset.session), await page.eval(dealt)], ['s-hooks', []]));
      await page.click('main button[aria-label="Skip to the next card"]');
      await page.until('s-group at the front', frontIs, 's-group');
      assert.deepEqual(await page.eval(dealt), ['back']);
    },
  },
  {
    name: 'P7.dock-waits typing in New task over the empty queue: a card that arrives meanwhile brings the queue and the dock under the dialog, and the prompt keeps focus and text',
    scenario: 'zero',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the empty queue', () => document.querySelector('main h1')?.textContent === 'All caught up.');
      await openNewTask(page);
      await page.type('Add retries');
      await mock.post('/mock/add', { template: 'ask', id: 's-new', rank: 1 });
      await page.until('the arrival in the meter', () => !!document.querySelector('[data-segment][data-session="s-new"]'));
      await page.until('the card and the dock', () => !!document.querySelector('[data-card]') && !!document.querySelector('[data-dock]'));
      assert.deepEqual(await page.eval(() => [document.querySelector<HTMLTextAreaElement>('dialog#new-task textarea')?.value, document.activeElement === document.querySelector('dialog#new-task textarea')]), ['Add retries', true]);
    },
  },
  {
    name: 'P7.new-task-fade Esc closes New task over the queue and takes focus out of its prompt at once, so a key typed while the dialog fades out does not land in it',
    async run({ page, mock }) {
      await openQueue(page, mock);
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
      await openQueue(page, mock);
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
    name: 'P7.reply-hint with the reply box and its command list open, the hint line under the box shows whole, above the card\'s faded edge and the footer',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('/re');
      await page.until('the command list', () => document.querySelectorAll('[data-card] [role="option"]').length > 0);
      await page.until('the command list to settle', settled);
      const at = await page.eval(() => {
        const hint = [...document.querySelectorAll('[data-card] section p')].find((p) => p.textContent?.startsWith('Enter sends'))!.getBoundingClientRect();
        const scroll = document.querySelector('[data-card] [data-scroll]')!.getBoundingClientRect();
        const foot = document.querySelector('[data-card] footer')!.getBoundingClientRect();
        return { hint: Math.round(hint.bottom), fade: Math.round(scroll.bottom - 22), foot: Math.round(foot.top) };
      });
      assert.ok(at.hint <= at.fade && at.hint <= at.foot, `the hint line ends at ${at.hint}, the fade starts at ${at.fade} and the footer at ${at.foot}`);
      await shot('queue-composer');
    },
  },
  {
    name: 'P7.phone-card narrow window: every kind of card is one column with one peek, its footer takes at most two rows, and the primary shows at the top and the bottom of the page; the reply box scrolls into view above the footer',
    narrow: true,
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      for (const id of ['s-cart', 's-hooks', 's-group', 's-astro', 's-reviews']) {
        await page.until(`the card of ${id}`, frontIs, id);
        await page.until('the card to settle', still);
        const shape = await page.eval(narrowCard);
        assert.deepEqual({ ...shape, footRows: shape.footRows <= 2 }, { stacked: true, peeks: ['1'], sliver: false, footRows: true }, `${id}: ${JSON.stringify(shape)}`);
        assert.deepEqual(await page.eval(primaryAtEnds), { top: true, bottom: true, scrolls: true }, id);
        assert.deepEqual(await page.eval(sidewaysScroll), [], id);
        if (id === 's-cart') await shot('phone-ask');
        if (id === 's-hooks') await shot('phone-menu');
        if (id === 's-reviews') await shot('phone-your-turn');
        await page.key('ArrowRight');
      }
      await page.until('s-anchors at the front', frontIs, 's-anchors');
      await page.click('[data-segment][data-session="s-cart"]');
      await ready(page, 's-cart');
      await page.click('[data-card] footer button', 'Write my own');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.until('the reply box to settle', settled);
      const reply = await page.eval(() => {
        const hint = [...document.querySelectorAll('[data-card] section p')].find((p) => p.textContent?.startsWith('Enter sends'))!.getBoundingClientRect();
        const box = document.querySelector('[data-card] textarea')!.getBoundingClientRect();
        const foot = document.querySelector('[data-card] footer')!.getBoundingClientRect();
        return { box: box.top >= 0 && box.bottom <= foot.top, hint: hint.bottom <= foot.top };
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
      await page.goto(`${mock.url}/wall`);
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

      await openQueue(page, mock);
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
    name: 'P7.reduced-motion with reduced motion a card change runs no animation longer than 10 ms: skip, previous, a peek, an answer, its Undo and the answer again until its capsule rings',
    clock: 'fast',
    motion: 'reduce',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.eval(noteAnimations);
      await page.key('ArrowRight');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.key('ArrowLeft');
      await page.until('s-cart at the front', frontIs, 's-cart');
      await page.click('[data-peek="1"] > span');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.key('ArrowLeft');
      await ready(page, 's-cart');
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.key('z');
      await ready(page, 's-cart');
      await page.key('Enter');
      await page.until('the answered capsule ringing', () => !!document.querySelector('[data-capsule][data-session="s-cart"][data-fresh]'));
      // Frames for the ring's animations, if any, to be noted.
      await sleep(300);
      const all = await page.eval(animations);
      assert.ok(all.length > 0, 'no animation was noted');
      assert.deepEqual(all.filter((a) => !(a.end <= 10)).map((a) => a.text), []);
    },
  },
  {
    name: 'P7.contrast-queue every text on the queue, its dock, hover card, peeks, meter chips and toasts reads at 4.5:1 or more: an ask with its reply box, command list and Elaborate, a menu, an end-of-turn choice with its failed Elaborate and a running and a failed second opinion, Needs focus, Your turn, a send held, a refusal and a card that leaves',
    expectedErrors: [/status of 400/],
    async run({ themes, page, mock }) {
      const fails: string[] = [];
      // A card that just came up shows its primary dimmed for 0.9 s; each step is read once that is over.
      const audit = async (where: string) => {
        await page.until('the guard to end', unguarded);
        await page.until('the page to settle', still);
        await themes(async (scheme) => {
          fails.push(...(await page.eval(lowContrast, 4.5)).map((f) => `${where} (${scheme}): ${f}`));
        });
      };
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await audit('ask');
      await page.key('w');
      await page.type('/re');
      await page.until('the command list', () => document.querySelectorAll('[data-card] [role="option"]').length > 0);
      await audit('reply box');
      await page.key('Escape');
      await page.key('Escape');
      await page.key('y');
      await page.until('the explanation', () => !!document.querySelector('[data-card] [data-elaborate="done"]'));
      await audit('Elaborate');
      await page.key('y');
      await page.hover('[data-capsule][data-session="s-invoice"] button');
      await page.until('the hover card', hoverCard, 's-invoice');
      await audit('hover card');
      await page.pointAt(720, 300);
      await page.key('ArrowRight');
      await ready(page, 's-hooks');
      await audit('menu');
      await page.key('ArrowRight');
      await ready(page, 's-group');
      await page.key('y');
      await page.until('the failed explanation', () => !!document.querySelector('[data-card] [data-elaborate="failed"]'));
      await audit('end of turn, Elaborate failed');
      await mock.post('/mock/advice', { id: 's-group', state: 'thinking' });
      await page.until('the running second opinion', () => !!document.querySelector('[data-card] [data-advice="running"]'));
      await audit('second opinion running');
      await mock.post('/mock/advice', { id: 's-group', state: 'failed' });
      await page.until('the failed second opinion', () => !!document.querySelector('[data-card] [data-advice="failed"]'));
      await audit('second opinion failed');
      await page.key('ArrowRight');
      await ready(page, 's-astro');
      await audit('Needs focus');
      await page.key('ArrowRight');
      await ready(page, 's-reviews');
      await audit('Your turn');
      await page.click('[data-segment][data-session="s-cart"]');
      await ready(page, 's-cart');
      await page.click('[data-card] h1');
      await mock.post('/mock/fail', { error: 'this question is no longer open', code: 'stale' });
      await page.key('Enter');
      await page.until('the undo toast', toastsOf, 'undo');
      await audit('a send held');
      await page.until('the refusal', toastsOf, 'error');
      await page.until('the Not sent peek', () => document.querySelector('[data-peek="1"]')?.textContent?.includes('Not sent'));
      await audit('refused');
      await page.click('[data-segment][data-session="s-cart"]');
      await page.until('the card marked Not sent', () => !!document.querySelector('[data-card] [data-not-sent]'));
      await audit('Not sent on the card');
      await mock.post('/mock/add', { template: 'ask', id: 's-new', rank: 9 });
      await page.until('Just in', () => !!document.querySelector('[data-justin]'));
      await mock.post('/mock/patch', { id: 's-cart', patch: { question: null, status: 'working', activity: { step: 'Edit src/cart/mergeCarts.ts', since: Date.now() } } });
      await page.until('s-cart off the queue', () => !document.querySelector('[data-segment][data-session="s-cart"]'));
      await audit('Just in, s-cart gone');
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
      await page.goto(`${mock.url}/wall`);
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
      await openQueue(page, mock);
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

      await page.click('[data-card] button[aria-label="Session actions"]');
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
    name: 'P7.send-capsules a send puts its capsule first, Sending in N s with Undo; two sends give two capsules, and each Undo takes back its own: the card comes back to the front with what its send took from the reply box; after the POST the capsule reads Sent, then turns into the working capsule with a fresh ring for about 2.6 s',
    async run({ holds, page, mock, shot }) {
      const capsules = async () => ((await page.eval(dockState))?.capsules ?? []).map((c) => ({ session: c.session, state: c.state, line: c.line }));
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('only if stock allows');
      await page.click('[data-card] [data-option="2"]');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      const [first] = await capsules();
      assert.deepEqual({ ...first, line: undefined }, { session: 's-cart', state: 'held', line: undefined });
      assert.match(first.line ?? '', /^Sending in [1-5] s$/);
      assert.equal(await page.eval(() => [...document.querySelectorAll('[data-capsule][data-session="s-cart"] button')].some((b) => b.textContent === 'Undo')), true);

      await ready(page, 's-hooks');
      await page.key('Enter');
      const pressed = Date.now();
      await page.until('s-group at the front', frontIs, 's-group');
      const two = await capsules();
      assert.deepEqual(two.slice(0, 2).map((c) => [c.session, c.state]), [['s-hooks', 'held'], ['s-cart', 'held']]);
      await shot('dock-sends');

      await page.click('[data-capsule][data-session="s-cart"] button', 'Undo');
      await page.until('s-cart back at the front', frontIs, 's-cart');
      assert.deepEqual({ ...(await page.eval(replyIn, '[data-card]')), focused: undefined }, { value: 'only if stock allows', files: [], focused: undefined });
      assert.deepEqual((await capsules()).filter((c) => c.state !== 'working').map((c) => [c.session, c.state]), [['s-hooks', 'held']]);

      // The answer goes out 5 s after the press and the mock then types the menu, which can outlast a 5 s wait that
      // starts this soon after the press, as it does when no deal or Undo runs an animation.
      await holds('the send to wait its 5 s', Math.max(0, 4000 - (Date.now() - pressed)), async () => matches((await capsules()).filter((c) => c.session === 's-hooks').map((c) => c.state), ['held']));
      await page.until('Sent on the capsule', () => {
        const c = document.querySelector<HTMLElement>('[data-capsule][data-session="s-hooks"]');
        return c?.dataset.state === 'sent' && c.innerText.includes('Sent');
      });
      assert.ok(Date.now() - pressed >= 4500, 'the send went out before its 5 s');
      await page.until('the working capsule, fresh', () => {
        const c = document.querySelector<HTMLElement>('[data-capsule][data-session="s-hooks"]');
        return c?.dataset.state === 'working' && c.hasAttribute('data-fresh');
      });
      const ringed = Date.now();
      await page.until('the ring to end', () => !document.querySelector('[data-capsule][data-session="s-hooks"][data-fresh]'));
      const ring = Date.now() - ringed;
      assert.ok(ring > 1800 && ring < 3400, `the ring lasted ${ring} ms`);
      const sent = await actions(mock);
      assert.deepEqual(sent.map((e) => [e.action, e.sessionId, e.status]), [['answer-menu', 's-hooks', 204]]);
    },
  },
  {
    name: 'P7.keyboard with no pointer at all: ⏎ answers and Z takes it back, → skips and ← goes back; O opens Overview, 2 the Diff, J a file, Esc all files and Esc the queue; V the Wall, N New task, typing and Esc; ? Keys and Esc',
    clock: 'fast',
    async run({ holds, page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.eval(() => {
        const w = window as unknown as { e2ePointer: number };
        w.e2ePointer = 0;
        for (const type of ['pointerdown', 'mousedown']) addEventListener(type, () => w.e2ePointer++, true);
      });
      await ready(page, 's-cart');
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.key('z');
      await page.until('s-cart back at the front', frontIs, 's-cart');
      await page.key('ArrowRight');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.key('ArrowLeft');
      await page.until('s-cart at the front', frontIs, 's-cart');

      await page.key('o');
      await page.until('Overview of s-cart', () => location.pathname === '/s/s-cart/overview' && !!document.querySelector('#task-sheet [data-queued]'));
      await page.key('3');
      await page.until('the Diff', () => location.pathname === '/s/s-cart/diff' && document.querySelectorAll('section[data-file] diffs-container').length === 12);
      await page.key('j');
      await page.until('one file, whole', () => document.querySelectorAll('section[data-file]').length === 1 && !!document.querySelector('[data-theme="dark"] > div')?.textContent?.includes('← All files'));
      await page.key('Escape');
      await page.until('all files again', () => document.querySelectorAll('section[data-file]').length === 12);
      assert.equal(await page.eval(sheetOpen), true);
      await page.key('Escape');
      await page.until('the queue', () => location.pathname === '/' && !document.querySelector('#task-sheet') && !!document.querySelector('[data-card]'));

      await page.key('v');
      await page.until('the Wall', () => location.pathname === '/wall' && document.querySelectorAll('[data-tile]').length > 0);
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
    name: 'P7.contrast-volume with 45 cards waiting every text on the queue reads at 4.5:1 or more too: the meter\'s bars with their counts, and a dock of sixteen capsules',
    scenario: 'volume45',
    async run({ themes, page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the bars', () => document.querySelectorAll('[data-bar]').length === 3);
      await page.until('the dock', docked, 16);
      await page.until('the page to settle', still);
      await themes(async (scheme) => assert.deepEqual(await page.eval(lowContrast, 4.5), [], scheme));
    },
  },
];
