import assert from 'node:assert/strict';
import { until } from '../cdp.ts';
import {
  decision, decisionOf, logged, matches, newTaskOnRepo, noDecision, openDecision, openNewTask, openSheetOf, reachable, ready, settled, sidewaysScroll, stateOf, still, tiles, toastsOf,
  unguarded, whole, type Check,
} from '../helpers.ts';

// The top bar's Next decision: its count, and whether it shows at all.
const nextInBar = () => {
  const b = document.querySelector<HTMLElement>('header [data-next-decision]');
  return b ? { text: b.innerText.replace(/\s+/g, ' ').trim(), tip: b.dataset.explain ?? '' } : null;
};

export const decisions: Check[] = [
  {
    name: 'P5.1.1 next decision: the top bar over the Wall offers Next decision 3, which opens s-cart, the first in the Wall\'s order; from there it names s-hooks with 2 besides, and D goes on to s-hooks, then s-group, then round to s-cart; Esc goes back to the Wall',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      assert.deepEqual(await page.until('Next decision', nextInBar), { text: 'Next decision 3 D', tip: 'Open Merge guest cart on login, the next task that waits for a decision (D)' });
      await shot('wall-next-decision');
      await page.click('header [data-next-decision]');
      await ready(page, 's-cart');
      assert.equal(await page.eval(() => location.pathname), '/s/s-cart/overview');
      assert.deepEqual(await page.eval(nextInBar), { text: 'Next decision 2 D', tip: 'Open Retry failed webhooks, the next task that waits for a decision (D)' });
      for (const [id, then] of [['s-hooks', 'Group board tiles by repo'], ['s-group', 'Merge guest cart on login'], ['s-cart', 'Retry failed webhooks']]) {
        await page.key('d');
        await page.until(id, decisionOf, id);
        assert.deepEqual(await page.eval(nextInBar), { text: 'Next decision 2 D', tip: `Open ${then}, the next task that waits for a decision (D)` });
      }
      await page.key('Escape');
      await page.until('the Wall', () => location.pathname === '/' && !document.querySelector('#task-sheet'));
      assert.equal((await page.eval(nextInBar))?.text, 'Next decision 3 D');
    },
  },
  {
    name: 'P5.1.2 after an answer on a task page the way on is there: ⏎ on s-cart holds its answer, the decision makes way for "2 more tasks wait for a decision" with Next decision, which opens s-hooks; Undo there brings s-cart\'s decision back on its page',
    clock: 'fast',
    async run({ page, mock, shot }) {
      await openDecision(page, mock);
      await page.key('Enter');
      await page.until('the decision to go', noDecision, 's-cart');
      const after = await page.until('the way on', () => document.querySelector<HTMLElement>('#task-sheet [data-next-after]')?.innerText.replace(/\s+/g, ' ').trim());
      assert.equal(after, '2 more tasks wait for a decision. Next decision D');
      await shot('task-next-after');
      await page.click('#task-sheet [data-next-after] button');
      await page.until('s-hooks', decisionOf, 's-hooks');
      await page.click('[data-toast][data-kind="undo"] button', 'Undo');
      await page.goto(`${mock.url}/s/s-cart/overview`);
      await page.until('s-cart\'s decision back', decisionOf, 's-cart');
      assert.deepEqual((await mock.log()).filter((e) => e.method === 'POST' && e.action), []);
    },
  },
  {
    name: 'P5.1.3 s-cart\'s Overview holds what its decision needs, after Claude\'s latest reply: its kind and category and how long ago it was asked, the question, Claude\'s details, the three options numbered with their descriptions, and the main button naming Claude\'s recommended option',
    async run({ page, mock, shot }) {
      await openDecision(page, mock);
      const shown = (await page.eval(decision))!;
      assert.deepEqual([shown.kind, shown.key, shown.primary, shown.disabled], ['ask', 'q:toolu_01Cart', 'Send “Merge both carts”', false]);
      for (const part of [
        'DECISION · product decision · asked 10m ago', 'Guest cart or account cart when a shopper logs in?', "CLAUDE'S DETAILS", 'CartService.mergeOnLogin',
        'Add up quantities per product, capped at stock; a toast lists anything trimmed', 'Drop the guest cart as today, but tell the shopper',
        'A choice dialog after login; one more step before checkout', 'Claude recommends', 'Dismiss',
      ]) assert.ok(shown.text.includes(part), `the decision lacks ${part}:\n${shown.text}`);
      assert.doesNotMatch(shown.text, /queue|Open its card/i);
      const options = await page.eval(() => [...document.querySelectorAll<HTMLElement>('[data-decision] [data-option]')].map((o) => o.innerText.split('\n')[0]));
      assert.deepEqual(options, ['1', '2', '3']);
      assert.equal(await page.eval(() => {
        const reply = document.querySelector('#task-sheet [data-reply], #task-sheet section[aria-label="Claude\'s latest reply"]') ?? [...document.querySelectorAll('#task-sheet h3')].find((h) => /latest reply/i.test(h.textContent ?? ''));
        const d = document.querySelector('#task-sheet [data-decision]')!;
        return !!reply && !!(reply.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING);
      }), true, 'the latest reply does not come before the decision');
      await page.eval(() => document.querySelector('[data-decision]')!.scrollIntoView({ block: 'start' }));
      await page.until('the page to settle', still);
      await shot('task-decision');
    },
  },
  {
    name: 'P5.1.5 s-hooks\'s menu on its page: the questions numbered 1–3 and 4–6, the main button waits for both, a pick in each makes it Send answer, and ⏎ holds answer-menu with the picks',
    clock: 'fast',
    async run({ page, mock, shot }) {
      await openDecision(page, mock, 's-hooks');
      const menu = await page.eval(() => [...document.querySelectorAll('[data-decision] section[role="group"]')].map((q) => [...q.querySelectorAll<HTMLElement>('[data-option]')].map((o) => o.dataset.option)));
      assert.deepEqual(menu, [['1', '2', '3'], ['4', '5', '6']]);
      assert.deepEqual([(await page.eval(decision))!.kind, (await page.eval(decision))!.primary, (await page.eval(decision))!.disabled], ['menu', 'Answer both questions', true]);
      assert.match((await page.eval(decision))!.text, /ASKED IN THE TERMINAL · asked 9m ago/);
      await page.click('[data-decision] [data-option="2"]');
      await page.click('[data-decision] [data-option="4"]');
      await page.until('Send answer', () => document.querySelector('[data-decision] [data-primary]:not(:disabled)')?.textContent?.startsWith('Send answer'));
      await page.until('the page to settle', still);
      await shot('task-menu');
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.key('Enter');
      const [sent] = await logged(mock, 'the menu answer', (e) => e.action === 'answer-menu', 8000);
      assert.deepEqual([sent.status, sent.body], [204, { toolUseId: 'toolu_01Hooks', answers: [{ labels: ['Every 15 min, 8 tries'], other: '' }, { labels: ['Email the account owner'], other: '' }] }]);
    },
  },
  {
    name: 'P5.1.6 Space hides the details and the toggle reads Show; Conversation and back to Overview shows them again',
    async run({ page, mock }) {
      await openDecision(page, mock);
      const details = () => {
        const section = document.querySelector<HTMLElement>('[data-decision] section[aria-label="Claude\'s details"]');
        const toggle = section?.querySelector('button');
        return section && { shown: section.innerText.includes('CartService.mergeOnLogin'), toggle: toggle?.textContent, expanded: toggle?.getAttribute('aria-expanded') };
      };
      assert.deepEqual(await page.eval(details), { shown: true, toggle: 'Hide Space', expanded: 'true' });
      await page.key(' ');
      assert.deepEqual(await page.until('the details hidden', () => {
        const section = document.querySelector<HTMLElement>('[data-decision] section[aria-label="Claude\'s details"]');
        return section && !section.innerText.includes('CartService.mergeOnLogin') && { toggle: section.querySelector('button')?.textContent, expanded: section.querySelector('button')?.getAttribute('aria-expanded') };
      }), { toggle: 'Show Space', expanded: 'false' });
      await page.key('2');
      await page.until('Conversation', () => location.pathname === '/s/s-cart/conversation');
      await page.key('1');
      await page.until('the decision again', decisionOf, 's-cart');
      assert.deepEqual(await page.eval(details), { shown: true, toggle: 'Hide Space', expanded: 'true' });
    },
  },
  {
    name: 'P5.1.8 W goes to the decision\'s reply box; /re lists /review and /rename, Esc closes only the list, Shift+Enter adds a line in place of picking one, Tab completes "/rename ", and a second Esc goes back to the Wall',
    async run({ page, mock, shot }) {
      await openDecision(page, mock);
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-decision] textarea'));
      await page.type('/re');
      const listed = () => {
        const list = [...document.querySelectorAll('[data-decision] [role="listbox"] [role="option"] code')].map((c) => c.textContent);
        return list.length ? list : null;
      };
      const list = await page.until('the command list', listed);
      assert.ok(list.includes('/rename') && list.includes('/review'), list.join(', '));
      await page.until('the page to settle', still);
      await shot('task-composer');
      await page.key('Escape');
      await page.until('the list to close', () => !document.querySelector('[data-decision] [role="listbox"]'));
      const box = () => ({ value: document.querySelector<HTMLTextAreaElement>('[data-decision] textarea')?.value ?? null, focused: document.activeElement?.matches('[data-decision] textarea') ?? false });
      assert.deepEqual(await page.eval(box), { value: '/re', focused: true });
      await page.type('n');
      assert.deepEqual(await page.until('the list again', listed), ['/rename']);
      await page.key('Enter', { shift: true });
      await page.until('Shift+Enter to add a line, not pick /rename', () => document.querySelector<HTMLTextAreaElement>('[data-decision] textarea')?.value === '/ren\n');
      await page.key('Backspace');
      assert.deepEqual(await page.until('the list back', listed), ['/rename']);
      await page.key('Tab');
      assert.deepEqual(await page.until('the completion', () => document.querySelector<HTMLTextAreaElement>('[data-decision] textarea')?.value === '/rename ' && !document.querySelector('[data-decision] [role="listbox"]') && true), true);
      await page.key('Escape');
      await page.until('the Wall', () => location.pathname === '/' && !document.querySelector('#task-sheet'));
    },
  },
  {
    name: 'P5.1.8p a repository\'s own skill is suggested in its own worktrees only: /pr-to lists /pr-to-green on a storefront task and nothing on a billing-api one, each asking for its worktree\'s commands',
    async run({ holds, page, mock }) {
      const home = await mock.home();
      const listed = () => [...document.querySelectorAll('#task-sheet [role="listbox"] [role="option"] code')].map((c) => c.textContent);
      const ask = async (id: string, worktree: string) => {
        await page.goto(`${mock.url}/s/${id}/overview`);
        await page.click('#task-sheet textarea');
        await page.type('/pr-to');
        await logged(mock, `${id}'s commands`, (e) => e.path === '/api/commands' && new URLSearchParams(e.query).get('worktree') === worktree);
      };
      await ask('s-search', `${home}/code/worktrees/search-typos/storefront`);
      assert.deepEqual(await page.until('the storefront skill', () => {
        const list = [...document.querySelectorAll('#task-sheet [role="listbox"] [role="option"] code')].map((c) => c.textContent);
        return list.length ? list : null;
      }), ['/pr-to-green']);
      await ask('s-invoice', `${home}/code/worktrees/invoice-rounding/billing-api`);
      await holds('no skill of storefront\'s listed', 500, async () => matches(await page.eval(listed), []));
    },
  },
  {
    name: 'P5.1.11 Needs focus: Migrate docs to Astro 5\'s page says Claude shows a permission prompt in its terminal, with no decision, and its Terminal button asks for the terminal at once',
    async run({ holds, page, mock }) {
      await openSheetOf(page, mock, 's-astro');
      const prompt = await page.until('the terminal prompt', () => document.querySelector<HTMLElement>('#task-sheet [data-prompt]')?.innerText);
      assert.match(prompt, /^Claude is showing a permission prompt for Bash\(pnpm dlx @astrojs\/upgrade\) in its terminal\. Answer it there\.\s+Terminal$/);
      assert.equal(await page.eval(decision), null);
      await page.key('Enter');
      await holds('⏎ to do nothing without a decision', 400, async () => !(await mock.log()).some((e) => e.action === 'focus'));
      const pressed = Date.now();
      await page.click('#task-sheet [data-prompt] button', 'Terminal');
      const [focus] = await logged(mock, 'the terminal request', (e) => e.action === 'focus');
      assert.deepEqual([focus.sessionId, focus.status], ['s-astro', 204]);
      assert.ok(focus.at - pressed < 1000, `asked for the terminal ${focus.at - pressed} ms after the click`);
    },
  },
  {
    name: 'P5.1.12 a decision that arrives counts in Next decision at once, also while a task page is open, and the Wall lists it first',
    async run({ page, mock }) {
      await openDecision(page, mock, 's-hooks');
      assert.equal((await page.eval(nextInBar))?.text, 'Next decision 2 D');
      await mock.post('/mock/add', { template: 'ask', id: 's-new' });
      await page.until('the count to grow', () => document.querySelector<HTMLElement>('header [data-next-decision]')?.innerText.replace(/\s+/g, ' ').trim() === 'Next decision 3 D');
      assert.equal((await page.eval(decision))!.session, 's-hooks', 'the open task stays');
      await page.key('Escape');
      await page.until('the tiles', tiles);
      assert.equal(await page.eval(() => document.querySelector<HTMLElement>('[data-tile]')?.dataset.session), 's-cart');
      assert.ok(await page.eval(() => [...document.querySelectorAll<HTMLElement>('[data-tile][data-attention="decide"]')].some((t) => t.dataset.session === 's-new')));
    },
  },
  {
    name: 'P5.1.13 when s-hooks stops waiting for a reason outside the page, its decision leaves its page, with no toast',
    async run({ holds, page, mock }) {
      await openDecision(page, mock, 's-hooks');
      await mock.post('/mock/patch', { id: 's-hooks', patch: { menu: null, status: 'working' } });
      await page.until('the decision to go', noDecision, 's-hooks');
      await holds('no toast', 300, async () => (await page.eval(toastsOf, 'info')) === null);
    },
  },
  {
    name: 'P5.1.14 a new decision on s-cart, on its open page, updates it in place: its key is q:toolu_02, and the guard holds the main button for about 0.9 s',
    async run({ page, mock, shot }) {
      await openDecision(page, mock);
      await mock.post('/mock/patch', {
        id: 's-cart',
        patch: { question: { toolUseId: 'toolu_02', title: 'Merge the carts for app logins too?', options: [{ label: 'Yes, everywhere', recommended: true }, { label: 'Only on the web' }] } },
      });
      const sent = Date.now();
      await page.until('the update', () => {
        const d = document.querySelector<HTMLElement>('[data-decision]');
        return d?.dataset.key === 'q:toolu_02' && !!d.querySelector('[data-primary][data-guarded]');
      });
      await page.until('the guard to end', unguarded);
      const held = Date.now() - sent;
      assert.ok(held > 700 && held < 1600, `the guard ended ${held} ms after the update`);
      const shown = (await page.eval(decision))!;
      assert.match(shown.text, /Merge the carts for app logins too\?[\s\S]*Yes, everywhere[\s\S]*Only on the web/);
      assert.equal(shown.primary, 'Send “Yes, everywhere”');
      await shot('task-updated');
    },
  },
  {
    name: 'P5.1.16 with nothing waiting / shows the Wall, All caught up., and no Next decision; a decision that arrives brings Next decision 1',
    scenario: 'zero',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the Wall at rest', () => document.querySelector('main h1')?.textContent === 'All caught up.');
      assert.deepEqual(await page.eval(() => [location.pathname, !!document.querySelector('[data-next-decision]'), !!document.querySelector('nav[aria-label="View"]')]), ['/', false, false]);
      await shot('wall-zero');
      await mock.post('/mock/add', { template: 'ask', id: 's-new' });
      assert.equal((await page.until('Next decision', nextInBar)).text, 'Next decision 1 D');
      assert.equal(await page.eval(() => location.pathname), '/');
    },
  },
  {
    name: 'P5.1.17 an ended session with an open question counts in no Next decision, shows no decision on its page, and is on the Wall as Ended',
    scenario: 'ended-question',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      assert.equal((await page.until('Next decision', nextInBar)).text, 'Next decision 3 D');
      assert.equal(await page.eval(() => document.querySelector('[data-tile][data-session="s-gone"]')?.getAttribute('data-attention')), 'exited');
      await openSheetOf(page, mock, 's-gone');
      await page.until('its page', () => !!document.querySelector('#task-sheet [data-ended]'));
      assert.equal(await page.eval(decision), null);
    },
  },
  {
    name: 'P5.1.18 long details and eight options, and a menu of three questions: the task page scrolls as one, nothing inside the decision scrolls on its own, and every option, the last own answer and the main button scroll into view',
    scenario: 'long',
    async run({ page, mock, shot }) {
      const scrolls = () => {
        const d = document.querySelector('[data-decision]')!;
        const scroll = d.closest<HTMLElement>('#task-sheet [role="tabpanel"] > div')!;
        const inner = [d, ...d.querySelectorAll<HTMLElement>('*')].filter((el) => {
          const { overflowY } = getComputedStyle(el);
          return el.tagName !== 'TEXTAREA' && (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
        });
        return { scrolls: scroll.scrollHeight > scroll.clientHeight + 20, inner: inner.map((el) => el.className), page: document.scrollingElement!.scrollHeight === innerHeight };
      };
      const reveal = (selector: string) => document.querySelector(selector)!.scrollIntoView({ block: 'end' });
      await openDecision(page, mock);
      assert.deepEqual(await page.eval(scrolls), { scrolls: true, inner: [], page: true });
      assert.equal(await page.eval(() => document.querySelectorAll('[data-decision] [data-option]').length), 8);
      for (const selector of ['[data-decision] [data-option="1"]', '[data-decision] [data-option="8"]', '[data-decision] [data-primary]']) {
        await page.eval(reveal, selector);
        await page.until(`${selector} to show whole`, whole, selector);
      }
      await shot('task-long');
      await openDecision(page, mock, 's-hooks');
      assert.deepEqual(await page.eval(scrolls), { scrolls: true, inner: [], page: true });
      for (const selector of ['[data-decision] [data-option="9"]', '[data-decision] section[role="group"]:last-of-type input', '[data-decision] [data-primary]']) {
        await page.eval(reveal, selector);
        await page.until(`${selector} to show whole`, whole, selector);
      }
      await shot('task-long-menu');
    },
  },
  {
    name: 'P5.1.20 N opens New task over the Wall with the repository focused and Esc closes it; /wall is the Wall at /; a waiting tile opens its task page with its decision over the Wall, and Back goes to the Wall again',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the Wall at /', () => location.pathname === '/' && document.querySelectorAll('[data-tile]').length > 0);
      await page.key('n');
      await page.until('New task, its repository focused', newTaskOnRepo);
      await page.key('Escape');
      await page.until('the dialog to close', () => !document.querySelector('dialog#new-task[open]') && !document.activeElement?.closest('dialog'));
      await page.click('[data-tile][data-session="s-group"] p');
      await page.until('the task page of s-group with its decision', () => location.pathname === '/s/s-group/overview' && !!document.querySelector('#task-sheet [data-decision]'));
      assert.equal(await page.eval(() => document.querySelector('#task-sheet header button[aria-label="Back to the Wall"]')?.textContent), 'WallEsc');
      await page.click('#task-sheet header button[aria-label="Back to the Wall"]');
      await page.until('the Wall', () => location.pathname === '/' && !document.querySelector('#task-sheet') && document.querySelectorAll('[data-tile]').length > 0);
    },
  },
  {
    name: 'P5.1.20b N opens New task over a task page too, its repository focused, and Esc closes it back to the task page',
    async run({ page, mock }) {
      await openSheetOf(page, mock, 's-cart');
      await page.until('the task page to settle', settled);
      await page.key('n');
      await page.until('New task over the task page, its repository focused', newTaskOnRepo);
      await page.key('Escape');
      await page.until('the dialog to close', () => !document.querySelector('dialog#new-task[open]'));
      assert.deepEqual(await page.eval(() => [location.pathname, !!document.querySelector('#task-sheet')]), ['/s/s-cart/overview', true]);
    },
  },
  {
    name: 'P5.1.21 typing in New task over the Wall while a session arrives: "we fix 3 x" and Shift+Enter stay in the prompt, which keeps focus while the tile comes up under the dialog; nothing is held, archived or undone',
    scenario: 'zero',
    async run({ holds, page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the Wall at rest', () => document.querySelector('main h1')?.textContent === 'All caught up.');
      await openNewTask(page);
      await page.type('Fix the login ');
      await mock.post('/mock/add', { template: 'idle', id: 's-idle' });
      await page.until('the arrival on the Wall', () => !!document.querySelector('[data-tile][data-session="s-idle"]'));
      for (const key of 'we fix 3 x') await page.key(key);
      await page.key('Enter', { shift: true });
      const prompt = () => ({
        open: !!document.querySelector('dialog#new-task:modal'),
        value: document.querySelector<HTMLTextAreaElement>('dialog#new-task textarea')?.value,
        focused: document.activeElement === document.querySelector('dialog#new-task textarea'),
        toasts: [...document.querySelectorAll('[data-toast]')].length,
      });
      const untouched = async () => matches((await mock.log()).filter((e) => e.path.startsWith('/api/sessions/')), []);
      await holds('the keys to stay in the prompt', 300, async () => matches(await page.eval(prompt), { open: true, value: 'Fix the login we fix 3 x\n', focused: true, toasts: 0 }) && untouched());
      await shot('typing-over-an-arrival');
      await page.key('Escape');
      await page.until('New task to close', () => !document.querySelector('dialog#new-task[open]'));
      assert.equal(await page.eval(() => location.pathname), '/');
      await holds('nothing to go out', 300, untouched);
    },
  },
  {
    name: 'P5.1.22 a menu answered from the board but still open 10 s later is Needs focus on its page: Claude still shows its menu in the terminal, and Terminal opens it',
    scenario: 'menu-stuck',
    async run({ page, mock, shot }) {
      await openSheetOf(page, mock, 's-hooks');
      const prompt = await page.until('the terminal prompt', () => document.querySelector<HTMLElement>('#task-sheet [data-prompt]')?.innerText);
      assert.match(prompt, /^Claude still shows its menu in the terminal\. Answer it there\./);
      assert.equal(await page.eval(decision), null);
      await shot('task-menu-stuck');
      await page.click('#task-sheet [data-prompt] button', 'Terminal');
      const [focus] = await logged(mock, 'the terminal request', (e) => e.action === 'focus');
      assert.deepEqual([focus.sessionId, focus.status], ['s-hooks', 204]);
    },
  },
  {
    name: 'P5.1.24 narrow window: a decision\'s page has no sideways scroll and its main button stays in reach, an ask\'s and a menu\'s',
    narrow: true,
    async run({ page, mock, shot }) {
      for (const id of ['s-cart', 's-hooks']) {
        await openDecision(page, mock, id);
        assert.deepEqual(await page.eval(sidewaysScroll), []);
        await page.until('the main button in reach', reachable, '[data-decision] [data-primary]', '');
        await page.until('the page to settle', still);
        await shot(`narrow-task-${id}`);
      }
    },
  },
  {
    name: 'P5.1.wall-age at rest a Wall tile\'s age ends at the tile\'s padding edge, where its trash and ⋯ show instead on hover, each naming itself in a tooltip',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      const gaps = await page.eval(() => [...document.querySelectorAll<HTMLElement>('[data-tile]')].filter((t) => t.checkVisibility()).map((t) => {
        const style = getComputedStyle(t);
        const edge = t.getBoundingClientRect().right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
        const age = t.querySelector('[data-age]')!.getBoundingClientRect();
        return Math.round((edge - age.right) * 10) / 10;
      }));
      assert.ok(gaps.length >= 11);
      assert.deepEqual(gaps.filter((g) => Math.abs(g) > 0.5), [], `ages end ${gaps.join(', ')} px from the padding edge`);
      const tile = '[data-tile][data-session="s-invoice"]';
      const box = await page.eval((tile: string) => {
        const r = document.querySelector(`${tile} p`)!.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, tile);
      await page.pointAt(box.x, box.y);
      await page.until('the ⋯ in the age\'s place', (tile: string) => {
        const menu = document.querySelector<HTMLElement>(`${tile} button[aria-label="Session actions"]`)!;
        const age = document.querySelector<HTMLElement>(`${tile} [data-age]`)!;
        return getComputedStyle(menu.parentElement!).opacity === '1' && getComputedStyle(age).opacity === '0';
      }, tile);
      const clash = await page.eval((tile: string) => {
        const trash = document.querySelector(`${tile} [data-clear]`)!.getBoundingClientRect();
        const state = document.querySelector(`${tile} header > span`)!.getBoundingClientRect();
        return state.right > trash.left;
      }, tile);
      assert.equal(clash, false, 'the trash overlaps the state');
      const trash = await page.eval((tile: string) => {
        const r = document.querySelector(`${tile} [data-clear]`)!.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, tile);
      await page.pointAt(trash.x, trash.y);
      await page.until('the trash\'s tooltip', (tile: string) => {
        const after = getComputedStyle(document.querySelector(`${tile} [data-clear]`)!, '::after');
        return after.content === '"Clear task…"' && after.opacity === '1';
      }, tile);
      await shot('tile-hover');
    },
  },
  {
    name: 'P5.1.n1-card typing in the decision\'s reply box holds the decision as it is: a new one on the task waits, then shows in place with the same box and draft; the decision going waits too, until focus leaves',
    async run({ holds, page, mock }) {
      await openDecision(page, mock);
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-decision] textarea'));
      await page.type('only if stock');
      await page.eval(() => void ((window as unknown as { e2eField?: Element }).e2eField = document.querySelector('[data-decision] textarea')!));
      const box = () => {
        const field = document.querySelector<HTMLTextAreaElement>('[data-decision] textarea');
        return {
          key: document.querySelector<HTMLElement>('[data-decision]')?.dataset.key,
          value: field?.value, focused: !!field && document.activeElement === field, same: !!field && field === (window as unknown as { e2eField?: Element }).e2eField,
        };
      };
      await mock.post('/mock/patch', { id: 's-cart', patch: { question: { toolUseId: 'toolu_02', title: 'Merge the carts for app logins too?' } } });
      await until('the new decision in the snapshot', async () => (await stateOf(mock, 's-cart')).question.toolUseId === 'toolu_02');
      await holds('the decision to wait as it is', 500, async () => matches(await page.eval(box), { key: 'q:toolu_01Cart', value: 'only if stock', focused: true, same: true }));
      await page.click('[data-decision] h3');
      await page.until('the update in place', () => document.querySelector<HTMLElement>('[data-decision]')?.dataset.key === 'q:toolu_02');
      assert.deepEqual(await page.eval(box), { key: 'q:toolu_02', value: 'only if stock', focused: false, same: true });

      await page.click('[data-decision] textarea');
      await page.type(' allows');
      await mock.post('/mock/patch', { id: 's-cart', patch: { question: null, status: 'working' } });
      await until('s-cart working in the snapshot', async () => (await stateOf(mock, 's-cart')).status === 'working');
      await holds('the decision to stay while the reply box has focus', 500, async () => matches(await page.eval(box), { key: 'q:toolu_02', value: 'only if stock allows', focused: true, same: true }));
      await page.click('[data-wordmark]');
      await page.until('the decision to go once focus left', noDecision, 's-cart');
    },
  },
  {
    name: 'P5.1.d5 a turn that ends asking in plain text is Your turn, not a decision: the task page shows the whole reply with no options and Message Claude, and counts in no Next decision',
    scenario: 'turn-long',
    async run({ page, mock, shot }) {
      const { lastMessage } = await stateOf(mock, 's-push');
      await openSheetOf(page, mock, 's-push');
      const text = await page.until('the reply', () => document.querySelector<HTMLElement>('#task-sheet [role="tabpanel"]')?.innerText.includes('Should I push it?') && document.querySelector<HTMLElement>('#task-sheet [role="tabpanel"]')!.innerText);
      for (const line of ['I dropped that commit locally', 'listingUploads', 'only keeps the warning working', 'Should I push it?']) {
        assert.ok(text.includes(line), `the reply lacks “${line}”`);
      }
      assert.ok(lastMessage.endsWith('Should I push it?'));
      assert.deepEqual(await page.eval(() => [
        !!document.querySelector('#task-sheet [data-decision]'),
        document.querySelectorAll('#task-sheet [data-option]').length,
        !!document.querySelector('#task-sheet textarea[aria-label="Message Claude"], #task-sheet section[aria-label="Message Claude"] textarea'),
        document.querySelector<HTMLElement>('header [data-next-decision]')?.innerText.replace(/\s+/g, ' ').trim(),
      ]), [false, 0, true, 'Next decision 3 D']);
      await page.until('the page to settle', still);
      await shot('task-turn-long');
    },
  },
];
