import assert from 'node:assert/strict';
import { until } from '../cdp.ts';
import { card, frontIs, logged, matches, newTaskOnRepo, openNewTask, openQueue, peeks, reachable, segmentsNow, settled, sidewaysScroll, startsInScroll, stateOf, still, tiles, toastsOf, whole, type Check } from '../helpers.ts';

export const queueCard: Check[] = [
  {
    name: 'P5.1.1 the first card is s-cart, an ask, with Retry failed webhooks and Group board tiles by repo peeking out behind it and the sliver; its meter segment is the current one, 40 px wide',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      assert.deepEqual(await page.eval(() => [document.querySelector<HTMLElement>('[data-card]')?.dataset.kind, document.title]), ['ask', 'Pitwall']);
      assert.deepEqual((await page.eval(peeks)).map((p) => [p.peek, p.session, p.text.split('\n')[0]]), [
        ['1', 's-hooks', 'Retry failed webhooks'], ['2', 's-group', 'Group board tiles by repo'],
      ]);
      assert.equal(await page.eval(() => !!document.querySelector('[data-sliver]')), true);
      const segments = await page.until('the current segment at full width', () => {
        const all = [...document.querySelectorAll<HTMLElement>('[data-segment]')].map((s) => ({ session: s.dataset.session, current: s.hasAttribute('data-current'), width: s.getBoundingClientRect().width }));
        return all[0]?.width === 40 && all;
      });
      assert.deepEqual(segments.map((s) => [s.session, s.current]), [
        ['s-cart', true], ['s-hooks', false], ['s-group', false], ['s-astro', false], ['s-reviews', false], ['s-anchors', false],
      ]);
      await page.until('the card to settle', still);
      await shot('queue-ask');
    },
  },
  {
    name: 'P5.1.2 the card header names the branch and the task, Overview, Diff and Artifacts 2 but no repo; the meta has the rank reason and no rank number; Artifacts 2, O and D open the sheet',
    async run({ page, mock }) {
      await openQueue(page, mock);
      const { header } = (await page.eval(card))!;
      for (const text of ['guest-cart-merge', 'Merge guest cart on login', 'Overview', 'Diff', 'Artifacts 2', 'Blocks the checkout fix; Claude idles until you answer']) assert.ok(header.includes(text), `the header lacks ${text}:\n${header}`);
      assert.ok(!header.includes('storefront'), 'the header names storefront');
      assert.doesNotMatch(header, /#\d/);
      const closed = () => !document.querySelector('#task-sheet') && location.pathname === '/';
      await page.click('[data-card] header button', 'Artifacts 2');
      await page.until('the Artifacts tab', () => location.pathname === '/s/s-cart/artifacts' && !!document.querySelector('#task-sheet'));
      await page.key('Escape');
      await page.until('the sheet to close', closed);
      await page.key('o');
      await page.until('Overview', () => location.pathname === '/s/s-cart/overview' && !!document.querySelector('#task-sheet'));
      await page.key('Escape');
      await page.until('the sheet to close', closed);
      await page.key('d');
      await page.until('Diff', () => location.pathname === '/s/s-cart/diff' && !!document.querySelector('#task-sheet'));
    },
  },
  {
    name: 'P5.1.3 the decision fits the window and the page does not scroll: the headline, the brief, the details, all three options with their descriptions, the suggestion, and the task\'s rail with its goal and Session summary show; in a narrower window each starts in view, in the card\'s scroll area; Worth knowing and Claude\'s latest reply follow in that one scroll area',
    async run({ page, mock, look, shot }) {
      await openQueue(page, mock);
      await page.until('the card to settle', still);
      const fit = await page.eval(() => ({ card: !!document.querySelector('[data-card]'), scroll: document.scrollingElement!.scrollHeight, height: innerHeight }));
      assert.equal(fit.scroll, fit.height, 'the page scrolls');
      const parts = [
        '[data-card]', '[data-card] h1', '[data-card] h1 + p', '[data-card] section[aria-label="Claude\'s details"]',
        '[data-card] [data-option="1"]', '[data-card] [data-option="2"]', '[data-card] [data-option="3"]', '[data-card] [data-suggestion]', '[data-card] [data-primary]',
        // A narrower card puts the rail under the decision.
        ...(look.width >= 1440 ? ['[data-card] [data-rail]'] : []),
      ];
      // In a narrower window the columns are narrower and their text longer, so the card scrolls to what does not fit (I§3).
      for (const selector of parts) {
        if (await page.eval(whole, selector)) continue;
        assert.ok(look.width < 1440, `${selector} does not show whole`);
        assert.equal(await page.eval(startsInScroll, selector), true, `${selector} does not start in view in the card's scroll area`);
      }
      const options = await page.eval(() => [...document.querySelectorAll<HTMLElement>('[data-card] [data-option]')].map((o) => o.innerText.split('\n').slice(0, 2)));
      assert.deepEqual(options.map((o) => o[0]), ['1', '2', '3']);
      const text = (await page.eval(card))!.text;
      for (const part of [
        'Guest carts live in a cookie that expires after 24 h', 'What should happen to a guest cart when the shopper logs in?', 'Both carts can hold items; today the guest cart is silently dropped.',
        "CLAUDE'S DETAILS", 'Add up quantities per product, capped at stock; a toast lists anything trimmed', 'Drop the guest cart as today, but tell the shopper',
        'A choice dialog after login; one more step before checkout', "CLAUDE'S LATEST REPLY", 'I drafted mergeCarts() in src/cart/mergeCarts.ts',
      ]) assert.ok(text.includes(part), `the card lacks ${part}`);
      const rail = await page.eval(() => document.querySelector<HTMLElement>('[data-card] [data-rail]')!.innerText);
      for (const part of ['TASK', 'Shoppers lose their guest cart when they log in (CHK-412).', 'SESSION SUMMARY', 'Cart merge drafted with stock caps', 'Found CartService.mergeOnLogin is a no-op']) {
        assert.ok(rail.includes(part), `the rail lacks ${part}:\n${rail}`);
      }
      await shot('queue-fit');
      for (const selector of ['[data-card] [data-know]', '[data-card] [data-reply]', '[data-card] [data-rail]']) {
        await page.eval((sel: string) => document.querySelector(sel)!.scrollIntoView({ block: 'nearest' }), selector);
        await page.until(`${selector} to show whole`, whole, selector);
      }
    },
  },
  {
    name: 'P5.1.4 option 1 carries Second opinion\'s pick · 82% and Claude recommends, the reply, the reasoning, Edit E and high confidence, with the frozen highlight; the primary reads Accept suggestion',
    async run({ page, mock }) {
      await openQueue(page, mock);
      const first = await page.eval(() => {
        const option = document.querySelector('[data-card] [data-option="1"]')!.parentElement as HTMLElement;
        return { frozen: option.hasAttribute('data-frozen'), others: [...document.querySelectorAll('[data-card] [data-option]')].filter((o) => o.parentElement!.hasAttribute('data-frozen')).length, text: option.innerText };
      });
      assert.deepEqual([first.frozen, first.others], [true, 1]);
      for (const part of [
        "Second opinion's pick · 82%", 'Claude recommends', 'Merge both carts. Cap each line at available stock and show a toast listing anything trimmed.',
        'CHK-412 says a cart must never lose items', 'Edit\nE', 'high confidence you agree',
      ]) assert.ok(first.text.includes(part), `option 1 lacks ${part}:\n${first.text}`);
      assert.equal((await page.eval(card))!.primary, 'Accept suggestion');
    },
  },
  {
    name: 'P5.1.5 → skips to s-hooks, a menu whose questions stand side by side numbered 1–3 and 4–6 over the band Second opinion · 64% · medium, and focus moves onto it from the card that went; five more come back to s-cart, and ← brings the last card, Fix broken doc anchors',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.eval(() => document.querySelector<HTMLElement>('[data-card] [data-option="2"]')!.focus());
      await page.key('ArrowRight');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.equal(await page.eval(() => (document.activeElement as HTMLElement | null)?.dataset.session ?? document.activeElement?.tagName), 's-hooks');
      const menu = await page.eval(() => ({
        columns: [...document.querySelectorAll('[data-card] section[role="group"]')].map((q) => [...q.querySelectorAll<HTMLElement>('[data-option]')].map((o) => o.dataset.option)),
        tops: [...document.querySelectorAll('[data-card] section[role="group"]')].map((q) => Math.round(q.getBoundingClientRect().top)),
        band: document.querySelector<HTMLElement>('[data-card] [data-advice]')?.innerText ?? '',
      }));
      assert.deepEqual(menu.columns, [['1', '2', '3'], ['4', '5', '6']]);
      assert.equal(menu.tops[0], menu.tops[1], 'the questions are not side by side');
      assert.match(menu.band, /^Second opinion · 64% · medium/);
      await page.until('the card to settle', still);
      await shot('queue-menu');
      for (const id of ['s-group', 's-astro', 's-reviews', 's-anchors', 's-cart']) {
        await page.key('ArrowRight');
        await page.until(`${id} at the front`, frontIs, id);
      }
      await page.key('ArrowLeft');
      await page.until('the last card at the front', frontIs, 's-anchors');
      assert.match((await page.eval(card))!.label ?? '', /^Fix broken doc anchors · Your turn$/);
    },
  },
  {
    name: 'P5.1.6 Space hides the details and the toggle reads Show; → then ← brings s-cart back with its details shown',
    async run({ page, mock }) {
      await openQueue(page, mock);
      const details = () => {
        const section = document.querySelector<HTMLElement>('[data-card] section[aria-label="Claude\'s details"]');
        const toggle = section?.querySelector('button');
        return section && { shown: section.innerText.includes('CartService.mergeOnLogin'), toggle: toggle?.textContent, expanded: toggle?.getAttribute('aria-expanded') };
      };
      assert.deepEqual(await page.eval(details), { shown: true, toggle: 'Hide Space', expanded: 'true' });
      await page.key(' ');
      assert.deepEqual(await page.until('the details hidden', () => {
        const section = document.querySelector<HTMLElement>('[data-card] section[aria-label="Claude\'s details"]');
        return section && !section.innerText.includes('CartService.mergeOnLogin') && { toggle: section.querySelector('button')?.textContent, expanded: section.querySelector('button')?.getAttribute('aria-expanded') };
      }), { toggle: 'Show Space', expanded: 'false' });
      await page.key('ArrowRight');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.key('ArrowLeft');
      await page.until('s-cart again', frontIs, 's-cart');
      assert.deepEqual(await page.eval(details), { shown: true, toggle: 'Hide Space', expanded: 'true' });
    },
  },
  {
    name: 'P5.1.7 Elaborate: Y opens the explanation below the details, which stay, and asks for it once; it arrives about 1.2 s later; Y closes it. On s-group it fails with Could not explain: … and Retry asks again',
    async run({ page, mock, shot }) {
      await mock.post('/mock/patch', { id: 's-cart', patch: { explanation: null } });
      await openQueue(page, mock);
      await page.key('y');
      const below = (text: string) => {
        const why = document.querySelector<HTMLElement>('[data-card] [data-elaborate]');
        const details = document.querySelector<HTMLElement>('[data-card] section[aria-label="Claude\'s details"]');
        return !!why && !!details && why.innerText.includes(text) && details.innerText.includes('CartService.mergeOnLogin') &&
          !!(details.compareDocumentPosition(why) & Node.DOCUMENT_POSITION_FOLLOWING) && details.parentElement === why.parentElement;
      };
      await page.until('the explanation loading below the details', below, 'Reading the code to explain this…');
      const [asked] = await logged(mock, 'the request for the explanation', (e) => e.action === 'elaborate');
      assert.deepEqual([asked.sessionId, asked.body, asked.status], ['s-cart', { key: 'q:toolu_01Cart' }, 204]);
      await page.until('the explanation', below, 'Background.');
      const took = Date.now() - asked.at;
      assert.ok(took > 900 && took < 3000, `the explanation came ${took} ms after the request`);
      assert.equal(await page.eval(() => document.querySelector('[data-card] footer button[aria-pressed="true"]')?.textContent), 'Elaborate Y');
      await page.until('the card to settle', still);
      await shot('queue-elaborate');
      await page.key('y');
      await page.until('the explanation to close', () => !document.querySelector('[data-card] [data-elaborate]'));
      assert.equal(await page.eval(() => document.querySelector<HTMLElement>('[data-card] section[aria-label="Claude\'s details"]')?.innerText.includes('CartService.mergeOnLogin')), true);
      assert.equal((await mock.log()).filter((e) => e.action === 'elaborate').length, 1);

      await page.click('[data-peek="2"] > span');
      await page.until('s-group at the front', frontIs, 's-group');
      await page.key('y');
      const failed = await page.until('the failure', () => {
        const why = document.querySelector<HTMLElement>('[data-card] [data-elaborate="failed"]');
        return why?.innerText.includes('Retry') && why.innerText;
      });
      assert.match(failed, /Could not explain: the explanation run timed out after 300 s/);
      await page.click('[data-card] [data-elaborate] button', 'Retry');
      const asks = await until('the second request', async () => {
        const found = (await mock.log()).filter((e) => e.action === 'elaborate' && e.sessionId === 's-group' && e.status !== null);
        return found.length === 2 && found;
      });
      assert.deepEqual(asks.map((e) => [e.body.key, e.status]), [['s:t-group-4', 204], ['s:t-group-4', 204]]);
    },
  },
  {
    name: 'P5.1.8 W opens the reply box, focused; /re lists /review and /rename, Esc closes only the list, Shift+Enter adds a line in place of picking one, Tab completes "/rename ", and a second Esc closes the box and focuses the card',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.until('the guard to end', () => !document.querySelector('[data-card] footer[data-guarding]'));
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('/re');
      const listed = () => {
        const list = [...document.querySelectorAll('[data-card] [role="listbox"] [role="option"] code')].map((c) => c.textContent);
        return list.length ? list : null;
      };
      const list = await page.until('the command list', listed);
      assert.ok(list.includes('/rename') && list.includes('/review'), list.join(', '));
      await page.until('the card to settle', still);
      await shot('queue-composer');
      await page.key('Escape');
      await page.until('the list to close', () => !document.querySelector('[data-card] [role="listbox"]'));
      const box = () => ({ value: document.querySelector<HTMLTextAreaElement>('[data-card] textarea')?.value ?? null, focused: document.activeElement?.matches('[data-card] textarea') ?? false });
      assert.deepEqual(await page.eval(box), { value: '/re', focused: true });
      await page.type('n');
      assert.deepEqual(await page.until('the list again', listed), ['/rename']);
      await page.key('Enter', { shift: true });
      await page.until('Shift+Enter to add a line, not pick /rename', () => document.querySelector<HTMLTextAreaElement>('[data-card] textarea')?.value === '/ren\n');
      await page.key('Backspace');
      assert.deepEqual(await page.until('the list back', listed), ['/rename']);
      await page.key('Tab');
      assert.deepEqual(await page.until('the completion', () => document.querySelector<HTMLTextAreaElement>('[data-card] textarea')?.value === '/rename ' && !document.querySelector('[data-card] [role="listbox"]') && true), true);
      await page.key('Escape');
      await page.until('the box to close and the card to take focus', () => !document.querySelector('[data-card] textarea') && document.activeElement?.hasAttribute('data-card'));
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
    name: 'P5.1.9 E opens the reply box with the second opinion\'s reply, focused',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.until('the guard to end', () => !document.querySelector('[data-card] footer[data-guarding]'));
      await page.key('e');
      const box = await page.until('the reply box', () => {
        const field = document.querySelector<HTMLTextAreaElement>('[data-card] textarea');
        return field && { value: field.value, focused: document.activeElement === field };
      });
      assert.deepEqual(box, { value: 'Merge both carts. Cap each line at available stock and show a toast listing anything trimmed.', focused: true });
    },
  },
  {
    name: 'P5.1.10 a click on peek 2 brings s-group to the front; the 5th meter segment shows Lazy-load product reviews as a Your-turn card with its summary, latest reply, Session summary, and in the footer only the reply box and Archive X, on one row',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.click('[data-peek="2"] > span');
      await page.until('s-group at the front', frontIs, 's-group');
      await page.click('[data-segment]:nth-child(5)');
      await page.until('s-reviews at the front', frontIs, 's-reviews');
      const shown = (await page.eval(card))!;
      assert.deepEqual([shown.kind, shown.label, shown.primary], ['idle', 'Lazy-load product reviews · Your turn', null]);
      for (const part of [
        'Reviews now load when scrolled into view', "CLAUDE'S LATEST REPLY", 'The reviews section now loads when it comes within 600 px', 'SESSION SUMMARY', 'Reviews split into a lazy chunk (41 kB)', 'Archive\nX',
      ]) assert.ok(shown.text.includes(part), `the card lacks ${part}`);
      assert.equal(await page.eval(() => !!document.querySelector('[data-card] table')), true);
      const bar = await page.eval(() => {
        const foot = document.querySelector('[data-card] footer')!;
        const row = (e: Element | null) => e && Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2);
        const [box, archive] = [foot.querySelector('textarea'), [...foot.querySelectorAll('button')].find((b) => b.textContent.startsWith('Archive')) ?? null];
        const x = (e: Element | null) => e?.getBoundingClientRect().left;
        return { label: box?.getAttribute('aria-label'), oneRow: row(box) === row(archive), order: x(box)! < x(archive)! };
      });
      assert.deepEqual(bar, { label: 'Message Claude', oneRow: true, order: true });
      await page.until('the card to settle', still);
      await shot('queue-your-turn');
    },
  },
  {
    name: 'P5.1.11 Needs focus: Migrate docs to Astro 5 says Claude shows a permission prompt in its terminal, the plate names the tty and the subject, and ⏎ (Terminal) asks for the terminal at once',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.click('[data-segment][data-session="s-astro"]');
      await page.until('s-astro at the front', frontIs, 's-astro');
      const shown = (await page.eval(card))!;
      assert.deepEqual([shown.kind, shown.primary], ['prompt', 'Terminal']);
      assert.ok(shown.text.includes('Claude is showing a permission prompt for Bash(pnpm dlx @astrojs/upgrade) in its terminal'), shown.text);
      assert.ok(shown.text.includes('Claude’s terminal · /dev/ttys017\nBash(pnpm dlx @astrojs/upgrade)'), shown.text);
      await page.until('the card to settle', still);
      await shot('queue-needs-focus');
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.until('the guard to end', () => !document.querySelector('[data-card] footer[data-guarding]'));
      const pressed = Date.now();
      await page.key('Enter');
      const [focus] = await logged(mock, 'the terminal request', (e) => e.action === 'focus');
      assert.deepEqual([focus.sessionId, focus.status], ['s-astro', 204]);
      assert.ok(focus.at - pressed < 1000, `asked for the terminal ${focus.at - pressed} ms after ⏎`);
    },
  },
  {
    name: 'P5.1.12 with s-hooks at the front an urgent new decision arrives: the front stays, the Just-in chip names it (short where the slot is narrow) and its segment is marked; the chip brings it to the front and goes',
    async run({ page, mock, look }) {
      await openQueue(page, mock);
      await page.key('ArrowRight');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      const label = (await page.eval(card))!.label;
      await mock.post('/mock/add', { template: 'ask', id: 's-new', rank: 1 });
      const chip = await page.until('the Just-in chip', () => document.querySelector<HTMLElement>('[data-justin]')?.innerText.trim());
      assert.equal(chip, look.width > 1100 ? 'Just in: Retire the v1 orders API' : 'Just in');
      assert.equal((await page.eval(card))!.label, label);
      assert.deepEqual((await page.eval(segmentsNow)).filter((s) => s.new).map((s) => s.session), ['s-new']);
      await page.click('[data-justin]');
      await page.until('s-new at the front', frontIs, 's-new');
      await page.until('the chip to go', () => !document.querySelector('[data-justin]') && !document.querySelector('[data-segment][data-new]'));
    },
  },
  {
    name: 'P5.1.13 when s-hooks, at the front, stops waiting for a reason outside the page, the card after it comes up, with no toast',
    async run({ holds, page, mock }) {
      await openQueue(page, mock);
      await page.key('ArrowRight');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await mock.post('/mock/patch', { id: 's-hooks', patch: { menu: null, status: 'working' } });
      await page.until('s-group at the front', frontIs, 's-group');
      await holds('no toast', 300, async () => (await page.eval(toastsOf, 'info')) === null);
    },
  },
  {
    name: 'P5.1.14 a new decision on s-cart, at the front, updates it in place: its key is q:toolu_02, it reads Updated just now, and the guard holds the primary for about 0.9 s',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.until('the guard to end', () => !document.querySelector('[data-card] footer[data-guarding]'));
      const before = (await page.eval(card))!;
      await mock.post('/mock/patch', {
        id: 's-cart',
        patch: { question: { toolUseId: 'toolu_02', title: 'Merge the carts for app logins too?', options: [{ label: 'Yes, everywhere' }, { label: 'Only on the web' }] } },
      });
      const sent = Date.now();
      const updated = await page.until('the update', () => {
        const c = document.querySelector<HTMLElement>('[data-card]');
        return c?.dataset.key === 'q:toolu_02' && !!c.querySelector('[data-primary][data-guarded]') && { session: c.dataset.session, label: c.getAttribute('aria-label'), text: c.querySelector('header')!.innerText };
      });
      assert.deepEqual([updated.session, updated.label], ['s-cart', before.label]);
      assert.match(updated.text, /Updated just now/);
      await page.until('the guard to end', () => !document.querySelector('[data-card] footer[data-guarding]'));
      const held = Date.now() - sent;
      assert.ok(held > 700 && held < 1600, `the guard ended ${held} ms after the update`);
      assert.match((await page.eval(card))!.text, /Merge the carts for app logins too\?[\s\S]*Yes, everywhere[\s\S]*Only on the web/);
      await shot('queue-updated');
    },
  },
  {
    name: 'P5.1.15 a reload keeps the card at the front: s-group, brought up by a click on its peek, is still there',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.click('[data-peek="2"] > span');
      await page.until('s-group at the front', frontIs, 's-group');
      await page.goto(`${mock.url}/`);
      await page.until('the card', card);
      assert.equal((await page.eval(card))!.session, 's-group');
    },
  },
  {
    name: 'P5.1.16 with nothing waiting / shows the empty queue, All caught up., with the Queue toggle on and a way to the Wall; a decision that arrives comes to the front',
    scenario: 'zero',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the empty queue', () => document.querySelector('main[data-empty] h1')?.textContent === 'All caught up.');
      assert.deepEqual(await page.eval(() => [location.pathname, document.querySelector('nav[aria-label="View"] a[aria-label="Queue"]')?.getAttribute('href'), !!document.querySelector('[data-card]'), !!document.querySelector('[data-tile]')]), ['/', '/', false, false]);
      assert.equal(await page.eval(() => document.querySelector('main[data-empty] a')?.getAttribute('href')), '/wall');
      await shot('queue-zero');
      await mock.post('/mock/add', { template: 'ask', id: 's-new', rank: 1 });
      await page.until('the new card at the front', frontIs, 's-new');
      assert.equal(await page.eval(() => location.pathname), '/');
    },
  },
  {
    name: 'P5.1.17 an ended session with an open question stays out of the deck and the meter, and is on the Wall as Ended',
    scenario: 'ended-question',
    async run({ page, mock }) {
      await openQueue(page, mock);
      assert.deepEqual((await page.eval(segmentsNow)).map((s) => s.session), ['s-cart', 's-hooks', 's-group', 's-astro', 's-reviews', 's-anchors']);
      for (let i = 0; i < 6; i++) {
        assert.notEqual((await page.eval(card))!.session, 's-gone');
        await page.key('ArrowRight');
        await page.until('the next card', () => !document.documentElement.dataset.deal);
      }
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      assert.equal(await page.eval(() => document.querySelector('[data-tile][data-session="s-gone"]')?.getAttribute('data-attention')), 'exited');
    },
  },
  {
    name: 'P5.1.18 long details and eight options, and a menu of three questions: the card scrolls as one between its head and footer to Claude\'s latest reply at its end, nothing inside it scrolls on its own, and the footer stays in view',
    scenario: 'long',
    async run({ page, mock, shot }) {
      const scrolls = () => {
        const scroll = document.querySelector<HTMLElement>('[data-card] [data-scroll]')!;
        const inner = [...scroll.querySelectorAll<HTMLElement>('*')].filter((el) => {
          const { overflowY } = getComputedStyle(el);
          return el.tagName !== 'TEXTAREA' && (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
        });
        return {
          scrolls: scroll.scrollHeight > scroll.clientHeight + 20,
          inner: inner.map((el) => el.className),
          page: document.scrollingElement!.scrollHeight === innerHeight,
        };
      };
      const toEnd = () => {
        const scroll = document.querySelector<HTMLElement>('[data-card] [data-scroll]')!;
        scroll.scrollTop = scroll.scrollHeight;
      };
      const reveal = (selector: string) => document.querySelector(selector)!.scrollIntoView({ block: 'end' });
      const replyAtEnd = () => {
        const end = document.querySelector('[data-card] [data-reply]')!.getBoundingClientRect().bottom;
        const scroll = document.querySelector('[data-card] [data-scroll]')!.getBoundingClientRect();
        return end > scroll.top && end <= scroll.bottom;
      };
      await openQueue(page, mock);
      await page.until('the card to settle', still);
      assert.deepEqual(await page.eval(scrolls), { scrolls: true, inner: [], page: true });
      assert.equal(await page.eval(() => document.querySelectorAll('[data-card] [data-option]').length), 8);
      for (const selector of ['[data-card] [data-primary]', '[data-card] [data-option="1"]', '[data-card] [data-option="2"]']) {
        assert.equal(await page.eval(whole, selector), true, `${selector} is out of view`);
      }
      await shot('queue-long');
      await page.eval(toEnd);
      assert.equal(await page.eval(replyAtEnd), true, "Claude's latest reply is not at the end of the card");
      assert.equal(await page.eval(whole, '[data-card] [data-primary]'), true, 'the primary is out of view at the end of the card');
      await page.eval(reveal, '[data-card] [data-option="8"]');
      assert.equal(await page.eval(whole, '[data-card] [data-option="8"]'), true, 'option 8 does not scroll into view');
      await page.eval(reveal, '[data-card] [data-side="left"]');
      assert.equal(await page.eval(() => {
        const end = document.querySelector('[data-card] [data-side="left"]')!.getBoundingClientRect().bottom;
        const scroll = document.querySelector('[data-card] [data-scroll]')!.getBoundingClientRect();
        return end > scroll.top && end <= scroll.bottom;
      }), true, 'the end of the details does not scroll into view');

      await page.click('[data-peek][data-session="s-hooks"] > span');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.until('the card to settle', still);
      assert.deepEqual(await page.eval(scrolls), { scrolls: true, inner: [], page: true });
      await page.eval(toEnd);
      assert.equal(await page.eval(replyAtEnd), true, "Claude's latest reply is not at the end of the menu's card");
      for (const selector of ['[data-card] [data-option="9"]', '[data-card] section[role="group"]:last-of-type input', '[data-card] [data-primary]']) {
        await page.eval(reveal, selector);
        assert.equal(await page.eval(whole, selector), true, `${selector} does not scroll into view`);
      }
      await shot('queue-long-menu');
    },
  },
  {
    name: 'P5.1.19 a second opinion still running shows a spinner, a ticking clock, the step and Stop, which stops it at once; Retry asks again; on a menu the band shows running and failed too, and so does the task\'s page',
    clock: 'fast',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.click('[data-peek="2"] > span');
      await page.until('s-group at the front', frontIs, 's-group');
      const running = () => {
        const box = document.querySelector<HTMLElement>('[data-card] [data-advice="running"]');
        return box && { text: box.innerText, spinner: !!box.querySelector('[aria-hidden]'), clock: box.querySelector('strong + span')?.textContent ?? null };
      };
      const first = await page.until('the running second opinion', running);
      assert.match(first.text, /^Second opinion in progress\s+\d+:\d\d\s+Stop\s+Read web\/src\/order\.ts$/);
      assert.equal(first.spinner, true);
      await page.until('the clock to tick', (clock) => {
        const box = document.querySelector<HTMLElement>('[data-card] [data-advice="running"]');
        return !!box && box.querySelector('strong + span')?.textContent !== clock;
      }, first.clock);
      await page.until('the card to settle', still);
      await shot('queue-advice-running');
      const pressed = Date.now();
      await page.click('[data-card] [data-advice] button', 'Stop');
      const [stop] = await logged(mock, 'the stop', (e) => e.action === 'stop-advice');
      assert.deepEqual([stop.sessionId, stop.body, stop.status], ['s-group', { key: 's:t-group-4' }, 204]);
      assert.ok(stop.at - pressed < 1000, `stopped ${stop.at - pressed} ms after the press`);
      const stopped = await page.until('the stopped box', () => document.querySelector<HTMLElement>('[data-card] [data-advice="failed"]')?.innerText);
      assert.match(stopped, /^Second opinion stopped\s+Retry$/);
      await page.click('[data-card] [data-advice] button', 'Retry');
      const [retry] = await logged(mock, 'the retry', (e) => e.action === 'retry-advice');
      assert.deepEqual([retry.sessionId, retry.body, retry.status], ['s-group', { key: 's:t-group-4' }, 204]);

      await mock.post('/mock/advice', { id: 's-hooks', state: 'thinking' });
      await page.click('[data-segment][data-session="s-hooks"]');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      const band = await page.until('the band running', running);
      assert.match(band.text, /^Second opinion in progress\s+\d+:\d\d\s+Stop\s+Read the changed files$/);
      await mock.post('/mock/advice', { id: 's-hooks', state: 'failed' });
      const failed = await page.until('the band failed', () => document.querySelector<HTMLElement>('[data-card] [data-advice="failed"]')?.innerText);
      assert.match(failed, /^Second opinion failed: the advisor gave an empty answer\s+Retry$/);
      await page.until('the card to settle', still);
      await shot('queue-menu-advice-failed');
      await page.key('o');
      const onPage = await page.until('the failed second opinion on its page', () => document.querySelector<HTMLElement>('#task-sheet [data-queued] [data-advice="failed"]')?.innerText);
      assert.match(onPage, /^Second opinion failed: the advisor gave an empty answer\s+Retry$/);
      await mock.post('/mock/advice', { id: 's-hooks', state: 'thinking' });
      await page.until('the running second opinion on its page', () => !!document.querySelector('#task-sheet [data-queued] [data-advice="running"] button'));
    },
  },
  {
    name: 'P5.1.20 N opens New task over the queue with the repository focused and Esc closes it; V goes to the Wall and back; on the Wall a waiting tile opens its task page over the Wall, whose Open its card brings the card to the front, and so does a working one',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.key('n');
      await page.until('New task, its repository focused', newTaskOnRepo);
      await page.key('Escape');
      await page.until('the dialog to close', () => !document.querySelector('dialog#new-task[open]') && !document.activeElement?.closest('dialog'));
      await page.key('v');
      await page.until('the Wall', () => location.pathname === '/wall' && document.querySelectorAll('[data-tile]').length > 0);
      await page.key('v');
      await page.until('the queue', () => location.pathname === '/' && !!document.querySelector('[data-card]'));
      await page.key('v');
      await page.until('the Wall', () => location.pathname === '/wall' && document.querySelectorAll('[data-tile]').length > 0);
      await page.click('[data-tile][data-session="s-group"] p');
      await page.until('the task page of s-group over the Wall', () => location.pathname === '/s/s-group/overview' && !!document.querySelector('#task-sheet [data-queued]') &&
        (window.navigation.currentEntry?.getState() as { base?: string } | undefined)?.base === '/wall');
      await page.click('#task-sheet [data-queued] button', 'Open its card');
      await page.until('s-group at the front of the queue', () => location.pathname === '/' && document.querySelector<HTMLElement>('[data-card]')?.dataset.session === 's-group');
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await page.click('[data-tile][data-session="s-invoice"] p');
      await page.until('the sheet over the Wall', () => location.pathname === '/s/s-invoice/overview' && !!document.querySelector('#task-sheet') &&
        (window.navigation.currentEntry?.getState() as { base?: string } | undefined)?.base === '/wall');
    },
  },
  {
    name: 'P5.1.20b N opens New task over a task page too, its repository focused, and Esc closes it back to the task page',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.key('o');
      await page.until('the task page', () => location.pathname === '/s/s-cart/overview' && !!document.querySelector('#task-sheet'));
      await page.until('the task page to settle', settled);
      await page.key('n');
      await page.until('New task over the task page, its repository focused', newTaskOnRepo);
      await page.key('Escape');
      await page.until('the dialog to close', () => !document.querySelector('dialog#new-task[open]'));
      assert.deepEqual(await page.eval(() => [location.pathname, !!document.querySelector('#task-sheet')]), ['/s/s-cart/overview', true]);
    },
  },
  {
    name: 'P5.1.21 typing in New task over the empty queue while a session arrives: "we fix 3 x" and Shift+Enter stay in the prompt, which keeps focus while the card comes up under the dialog; nothing is held, archived or undone',
    scenario: 'zero',
    async run({ holds, page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the empty queue', () => document.querySelector('main h1')?.textContent === 'All caught up.');
      await openNewTask(page);
      await page.type('Fix the login ');
      await mock.post('/mock/add', { template: 'idle', id: 's-idle' });
      await page.until('the arrival in the meter', () => !!document.querySelector('[data-segment][data-session="s-idle"]'));
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
      await page.until('the card once New task closed', frontIs, 's-idle');
      await holds('nothing to go out', 300, untouched);
    },
  },
  {
    name: 'P5.1.22 a menu answered from the board but still open 10 s later is Needs focus: Claude still shows its menu in the terminal, and ⏎ opens the terminal',
    scenario: 'menu-stuck',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.click('[data-segment][data-session="s-hooks"]');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      const shown = (await page.eval(card))!;
      assert.deepEqual([shown.kind, shown.label, shown.primary], ['prompt', 'Retry failed webhooks · Needs focus', 'Terminal']);
      assert.ok(shown.text.includes('Claude still shows its menu in the terminal'), shown.text);
      await page.until('the card to settle', still);
      await shot('queue-menu-stuck');
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.until('the guard to end', () => !document.querySelector('[data-card] footer[data-guarding]'));
      await page.key('Enter');
      const [focus] = await logged(mock, 'the terminal request', (e) => e.action === 'focus');
      assert.deepEqual([focus.sessionId, focus.status], ['s-hooks', 204]);
    },
  },
  {
    name: 'P5.1.23 s-group waits for its second opinion with the primary off as Pick an option; when the advice finishes it becomes what ⏎ sends: Suggestion ready · Accept, guarded about 0.9 s, its option highlighted',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.click('[data-peek="2"] > span');
      await page.until('s-group at the front', frontIs, 's-group');
      await page.until('the guard to end', () => !document.querySelector('[data-card] footer[data-guarding]'));
      assert.deepEqual(await page.eval(() => {
        const c = document.querySelector<HTMLElement>('[data-card]')!;
        return [c.querySelector('[data-primary]')?.firstElementChild?.textContent, c.querySelector<HTMLButtonElement>('[data-primary]')?.disabled, c.querySelectorAll('[data-frozen]').length];
      }), ['Pick an option', true, 0]);
      await mock.post('/mock/advice', { id: 's-group', state: 'done', choice: 'By attention', confidence: 74 });
      const done = Date.now();
      const relabelled = await page.until('the relabel', () => {
        const c = document.querySelector<HTMLElement>('[data-card]')!;
        const p = c.querySelector<HTMLButtonElement>('[data-primary]')!;
        return p.hasAttribute('data-guarded') && {
          label: p.firstElementChild?.textContent, disabled: p.disabled,
          frozen: [...c.querySelectorAll('[data-frozen] [data-option]')].map((o) => o.textContent?.slice(0, 13)),
        };
      });
      assert.deepEqual(relabelled, { label: 'Suggestion ready · Accept', disabled: false, frozen: ['1By attention'] });
      await page.until('the guard to end', () => !document.querySelector('[data-card] footer[data-guarding]'));
      const held = Date.now() - done;
      assert.ok(held > 700 && held < 1600, `the guard ended ${held} ms after the advice finished`);
      await page.until('the card to settle', still);
      await shot('queue-suggestion-ready');
    },
  },
  {
    name: 'P5.1.24 narrow window: the queue has no sideways scroll and its primary stays in reach',
    narrow: true,
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.until('the card to settle', still);
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      assert.equal(await page.eval(() => {
        const r = document.querySelector('[data-primary]')!.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      }), true, 'the primary is not in the window at the top of the page');
      await shot('narrow-queue');
      await page.until('the primary in reach', reachable, '[data-primary]', '');
      await page.click('[data-segment][data-session="s-hooks"]');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await page.until('the primary in reach', reachable, '[data-primary]', '');
      await shot('narrow-queue-menu');
    },
  },
  {
    name: 'P5.1.wall-age at rest a Wall tile\'s age ends at the tile\'s padding edge, where its trash and ⋯ show instead on hover, each naming itself in a tooltip',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
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
  },  {
    name: 'P5.1.n1-card typing in the reply box holds the card as it is: a new decision on it waits, then updates it in place with the same box and draft; the card leaving waits too, until focus leaves',
    async run({ holds, page, mock }) {
      await openQueue(page, mock);
      await page.until('the guard to end', () => !document.querySelector('[data-card] footer[data-guarding]'));
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('only if stock');
      await page.eval(() => void ((window as unknown as { e2eField?: Element }).e2eField = document.querySelector('[data-card] textarea')!));
      const box = () => {
        const field = document.querySelector<HTMLTextAreaElement>('[data-card] textarea');
        return {
          session: document.querySelector<HTMLElement>('[data-card]')?.dataset.session, key: document.querySelector<HTMLElement>('[data-card]')?.dataset.key,
          value: field?.value, focused: !!field && document.activeElement === field, same: !!field && field === (window as unknown as { e2eField?: Element }).e2eField,
        };
      };
      await mock.post('/mock/patch', { id: 's-cart', patch: { question: { toolUseId: 'toolu_02', title: 'Merge the carts for app logins too?' } } });
      await until('the new decision in the snapshot', async () => (await mock.get('/api/state')).sessions.find((x: { id: string }) => x.id === 's-cart').question.toolUseId === 'toolu_02');
      await holds('the card to wait as it is', 500, async () => matches(await page.eval(box), { session: 's-cart', key: 'q:toolu_01Cart', value: 'only if stock', focused: true, same: true }));
      await page.click('[data-card] h1');
      await page.until('the update in place', () => document.querySelector<HTMLElement>('[data-card]')?.dataset.key === 'q:toolu_02');
      assert.deepEqual(await page.eval(box), { session: 's-cart', key: 'q:toolu_02', value: 'only if stock', focused: false, same: true });
      assert.match((await page.eval(card))!.header, /Updated just now/);

      await page.click('[data-card] textarea');
      await page.type(' allows');
      await mock.post('/mock/patch', { id: 's-cart', patch: { question: null, status: 'working' } });
      await until('s-cart working in the snapshot', async () => (await mock.get('/api/state')).sessions.find((x: { id: string }) => x.id === 's-cart').status === 'working');
      await holds('the card to stay while the reply box has focus', 500, async () => matches(await page.eval(box), { session: 's-cart', key: 'q:toolu_02', value: 'only if stock allows', focused: true, same: true }));
      // Not on the card, which goes as the pointer goes down.
      await page.click('[data-wordmark]');
      await page.until('the card after it once focus left', frontIs, 's-hooks');
    },
  },  {
    name: 'P5.1.d4 a decision without options shows its second opinion as a block of its own, highlighted as what ⏎ accepts, with Edit; Accept suggestion is the primary',
    scenario: 'freetext',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.click('[data-segment][data-session="s-flag"]');
      await page.until('s-flag at the front', frontIs, 's-flag');
      const shown = await page.eval(() => {
        const block = document.querySelector<HTMLElement>('[data-card] [data-suggestion]')!;
        return {
          options: document.querySelectorAll('[data-card] [data-option]').length, frozen: block.hasAttribute('data-frozen'), text: block.innerText,
          buttons: [...block.querySelectorAll('button')].map((b) => b.textContent),
        };
      });
      assert.deepEqual({ ...shown, text: undefined }, { options: 0, frozen: true, text: undefined, buttons: ['Edit E'] });
      assert.match(shown.text, /^Second opinion's own answer · 77%\s+Call it `checkout\.mergeGuestCart`, like the other checkout flags\.\s+Every flag in config\/flags\.ts follows checkout\.<feature>\.\s+Edit\s+E\s+high confidence you agree$/);
      assert.equal((await page.eval(card))!.primary, 'Accept suggestion');
      await page.until('the card to settle', still);
      await shot('queue-free-text');
    },
  },
  {
    name: 'P5.1.d5 an end-of-turn choice read from a long last message shows that whole message as its Context next to the options, Space hides and shows it, and the brief stays one line',
    scenario: 'turn-long',
    async run({ page, mock, shot }) {
      const { lastMessage, summary } = await stateOf(mock, 's-push');
      await openQueue(page, mock);
      await page.click('[data-segment][data-session="s-push"]');
      await page.until('s-push at the front', frontIs, 's-push');
      const shown = () => {
        const section = document.querySelector<HTMLElement>('[data-card] section[aria-label="Context"]');
        const lead = document.querySelector<HTMLElement>('[data-card] p[data-explain]');
        return {
          text: section?.querySelector<HTMLElement>(':scope > div:last-child:not(:first-child)')?.innerText ?? null,
          toggle: section?.querySelector('button')?.textContent, expanded: section?.querySelector('button')?.getAttribute('aria-expanded'),
          options: [...document.querySelectorAll<HTMLElement>('[data-card] [data-option]')].map((o) => o.innerText.split('\n').filter(Boolean)[1]),
          sideBySide: !!section && section.closest('[data-card]')!.querySelector('[data-option]')!.getBoundingClientRect().left > section.getBoundingClientRect().right,
          lead: lead && { text: lead.textContent, lines: Math.round(lead.getBoundingClientRect().height / parseFloat(getComputedStyle(lead).lineHeight)) },
        };
      };
      const before = await page.eval(shown);
      for (const line of ['I dropped that commit locally', 'listingUploads', 'only keeps the warning working', 'Should I push it?']) {
        assert.ok(before.text?.includes(line), `the Context lacks “${line}”`);
      }
      assert.ok(!before.text?.includes('7bb08719db4'), "the summarizer's context shows instead of the last message");
      assert.equal(before.text?.split(/\n+/).filter(Boolean).length, lastMessage.split(/\n+/).filter(Boolean).length);
      assert.deepEqual({ ...before, text: undefined }, {
        text: undefined, toggle: 'Hide Space', expanded: 'true', options: ['Push', "Don't push yet"], sideBySide: true,
        lead: { text: summary.decision.brief, lines: 1 },
      });
      await page.until('the card to settle', still);
      await shot('queue-turn-long');
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.key(' ');
      assert.deepEqual(await page.until('the context hidden', () => {
        const section = document.querySelector<HTMLElement>('[data-card] section[aria-label="Context"]');
        return section && !section.innerText.includes('listingUploads') && section.querySelector('button')?.getAttribute('aria-expanded');
      }), 'false');
      await page.key(' ');
      await page.until('the context shown again', () => !!document.querySelector<HTMLElement>('[data-card] section[aria-label="Context"]')?.innerText.includes('listingUploads'));
    },
  },
];
