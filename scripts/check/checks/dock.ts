import assert from 'node:assert/strict';
import { until } from '../cdp.ts';
import { docked, dockState, frontIs, hoverCard, matches, openCards, openFromWall, settled, sheetOpen, sidewaysScroll, withoutBoard, type Check } from '../helpers.ts';

export const dock: Check[] = [
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
      await page.until('Esc to close the sheet', () => !document.querySelector('#task-sheet') && location.pathname === '/wall');

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
      await withoutBoard(async (url) => {
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
    name: 'P6.1 the dock under the queue: "3 working", then the three working agents in board order, each with its name, a mono step and a clock that ticks; Fix invoice PDF rounding has a breathing PR dot and a Worth-knowing dot, Typo-tolerant search a Worth-knowing dot; "2 ended" names them and opens the Wall',
    clock: 'fast',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the dock', docked, 3);
      const dock = (await page.eval(dockState))!;
      assert.deepEqual(dock.capsules.map((c) => [c.session, c.state, c.name, c.line, c.mono, c.pr, c.know]), [
        ['s-invoice', 'working', 'Fix invoice PDF rounding', 'Bash: pnpm test invoices --run', true, 'breathe', true],
        ['s-search', 'working', 'Typo-tolerant search', 'Bash: pnpm search:reindex', true, null, true],
        ['s-thumbs', 'working', 'Artifact thumbnails in Overview', 'Edit web/src/components/Artifacts.tsx', true, null, false],
      ]);
      assert.deepEqual([dock.label, dock.count, dock.ended], [
        'Agents not waiting on you', '3 working', { text: '2 ended', title: 'Ended: Split-only diff view, Upgrade Stripe SDK to v18. Open the Wall to see them.' },
      ]);
      assert.equal(dock.box!.bottom, await page.eval(() => innerHeight), 'the dock is not at the bottom of the window');
      assert.ok(dock.capsules.every((c) => c.box!.top === dock.capsules[0].box!.top && c.box!.height === 50), 'the capsules are not one row of 50 px');
      for (const c of dock.capsules) assert.match(c.clock ?? '', /^\d+:\d\d$/, c.session);
      await until('every clock to tick', async () => (await page.eval(dockState))!.capsules.every((c, i) => c.clock !== dock.capsules[i].clock));
      await shot('dock');

      await page.click('[data-dock] a[href="/wall"]');
      await page.until('the Wall, with no dock', () => location.pathname === '/wall' && !!document.querySelector('[data-tile]') && !document.querySelector('[data-dock]'));
    },
  },
  {
    name: 'P6.2 hovering "Fix invoice PDF rounding" opens its card 150 ms later, a hint popover above the capsule with repo · branch, the step and the clock, the PR chip, Worth knowing and the summary; it closes when the pointer leaves, and keyboard focus opens a card at once while Tab passes the cards by',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the dock', docked, 3);
      await page.eval(() => {
        const w = window as unknown as { e2eHover: { entered?: number; opened?: number } };
        w.e2eHover = {};
        const capsule = document.querySelector('[data-capsule][data-session="s-invoice"]')!;
        capsule.addEventListener('pointerover', () => (w.e2eHover.entered ??= performance.now()));
        capsule.querySelector('[data-hovercard]')!.addEventListener('toggle', (e) => {
          if ((e as ToggleEvent).newState === 'open') w.e2eHover.opened ??= performance.now();
        });
      });
      await page.hover('[data-capsule][data-session="s-invoice"] button');
      await page.until('the hover card', hoverCard, 's-invoice');
      await page.until('the card to settle', settled);
      const card = (await page.eval(hoverCard, 's-invoice'))!;
      const { entered, opened } = await page.eval(() => (window as unknown as { e2eHover: { entered: number; opened: number } }).e2eHover);
      assert.ok(opened - entered >= 140 && opened - entered < 1000, `the card opened ${Math.round(opened - entered)} ms after the pointer entered`);
      assert.equal(card.popover, 'hint');
      assert.ok(card.inside, 'the card is not inside the window');
      assert.ok(card.box.bottom <= card.capsule.top, `the card ends at ${card.box.bottom}, below the capsule's top at ${card.capsule.top}`);
      assert.ok(Math.abs(card.box.left - card.capsule.left) < 1, 'the card does not start where its capsule does');
      for (const part of [
        'Fix invoice PDF rounding', 'billing-api · invoice-rounding', 'Bash: pnpm test invoices --run', 'PR 1842 · checks running',
        'Worth knowing: Two customers were billed one cent too much on three September invoices; support may want to know.',
        'Totals now use integer cents end to end; re-running the invoice tests before pushing the fix.',
      ]) {
        assert.ok(card.text.includes(part), `the card lacks "${part}":\n${card.text}`);
      }
      assert.match(card.text, /(^|\s)\d+:\d\d(\s|$)/);
      assert.doesNotMatch(card.text, /You answered/);
      await shot('hover-card');

      await page.pointAt(720, 200);
      await page.until('the card to close', () => !document.querySelector('[data-hovercard]:popover-open'));

      await page.eval(() => document.querySelector<HTMLElement>('[data-capsule][data-session="s-invoice"] button')!.focus());
      await page.key('Tab');
      assert.deepEqual(await page.eval(openCards), ['s-search'], 'Tab did not open the next capsule\'s card at once');
      await page.key('Tab');
      assert.equal(await page.eval(() => document.activeElement?.closest<HTMLElement>('[data-capsule]')?.dataset.session), 's-thumbs');
      assert.deepEqual(await page.eval(openCards), ['s-thumbs']);
    },
  },
  {
    name: 'P6.3 a click on a capsule opens its sheet on Overview over the queue, with its hover card closed; Esc goes back to the queue',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the dock', docked, 3);
      await page.hover('[data-capsule][data-session="s-invoice"] button');
      await page.until('the hover card', hoverCard, 's-invoice');
      await page.click('[data-capsule][data-session="s-invoice"] button');
      await page.until('the sheet', sheetOpen);
      assert.deepEqual(await page.eval(() => [location.pathname, window.navigation.currentEntry?.getState()]), ['/s/s-invoice/overview', { base: '/' }]);
      assert.deepEqual(await page.eval(openCards), []);
      await page.key('Escape');
      await page.until('the queue', () => location.pathname === '/' && !document.querySelector('#task-sheet') && !!document.querySelector('[data-dock]'));
    },
  },
  {
    name: 'P6.4 sixteen working agents (volume) at 1440×900: "16 working", every capsule 230 px wide or more and every name and step 80 px or more; the dock is 128 px tall at most and scrolls, the queue above keeps clear of it, and a capsule scrolled into view shows its whole card, over the dock\'s edge',
    scenario: 'volume',
    async run({ page, mock, look, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the dock', docked, 16);
      const dock = (await page.eval(dockState))!;
      assert.equal(dock.count, '16 working');
      assert.ok(dock.capsules.every((c) => c.state === 'working'));
      for (const c of dock.capsules) {
        assert.ok(c.box!.width >= 230, `${c.session} is ${c.box!.width} px wide`);
        assert.ok(c.nameBox!.width >= 80 && c.lineBox!.width >= 80, `${c.session}: name ${c.nameBox!.width} px, step ${c.lineBox!.width} px`);
      }
      assert.ok(dock.box!.height <= 128, `the dock is ${dock.box!.height} px tall`);
      assert.ok(dock.grid!.scrollHeight > dock.grid!.clientHeight, 'the capsules do not scroll');
      // The card shows above the dock, and at 1440×900 so does the top of each option. In a narrower window the column
      // beside the details is narrower and its options taller, so the card scrolls to the ones below (plan §6, risk 2).
      const room = await page.eval(() => {
        const dock = document.querySelector('[data-dock]')!.getBoundingClientRect();
        const card = document.querySelector('[data-card]');
        const shown = (el: Element) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(12, r.height / 2));
          return r.top < dock.top && !!hit && el.contains(hit);
        };
        const scroll = card?.querySelector<HTMLElement>('[data-scroll]');
        return {
          view: document.querySelector('main')!.getBoundingClientRect().bottom <= dock.top + 1,
          card: card && { above: card.getBoundingClientRect().bottom <= dock.top + 1, options: [...card.querySelectorAll('[data-option]')].map(shown) },
          scrolls: !!scroll && scroll.scrollHeight > scroll.clientHeight,
        };
      });
      assert.equal(room.view, true, 'the queue runs under the dock');
      if (room.card && look.width >= 1440) assert.deepEqual(room.card, { above: true, options: room.card.options.map(() => true) });
      else if (room.card) {
        assert.deepEqual({ above: room.card.above, first: room.card.options[0] }, { above: true, first: true });
        if (room.card.options.includes(false)) assert.equal(room.scrolls, true, 'an option is out of sight and the card does not scroll');
      }
      await shot('dock-volume');

      const last = dock.capsules.at(-1)!;
      await page.hover(`[data-capsule][data-session="${last.session}"] button`);
      await page.until('the card of the last capsule', hoverCard, last.session);
      await page.until('the card to settle', settled);
      const card = (await page.eval(hoverCard, last.session))!;
      const grid = (await page.eval(dockState))!.grid!.box!;
      assert.ok(card.text.startsWith(last.name!), 'the card is not that capsule\'s');
      assert.ok(card.inside, `the card of ${last.session} is not inside the window`);
      assert.ok(card.box.bottom <= card.capsule.top, 'the card is not above its capsule');
      assert.ok(card.box.top < grid.top, 'the card does not reach out of the dock');
      // The card takes no pointer, so let it take one for a moment: wherever it is drawn, nothing covers or clips it.
      const whole = await page.eval((id: string) => {
        const card = document.querySelector<HTMLElement>(`[data-capsule][data-session="${id}"] [data-hovercard]`)!;
        const r = card.getBoundingClientRect();
        card.inert = false;
        try {
          return [[r.left + 8, r.top + 8], [r.right - 8, r.top + 8], [r.left + 8, r.bottom - 8], [r.right - 8, r.bottom - 8]]
            .every(([x, y]) => card.contains(document.elementFromPoint(x, y)));
        } finally {
          card.inert = true;
        }
      }, last.session);
      assert.equal(whole, true, 'part of the card is clipped or covered');
      await shot('hover-card-volume');
    },
  },
  {
    name: 'P6.5 narrow window: the dock is one row of 250 px capsules that scrolls sideways while the page does not, no hover card opens, and a click on a capsule opens its sheet',
    narrow: true,
    async run({ holds, page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the dock', docked, 3);
      const row = await page.eval(() => {
        const dock = document.querySelector<HTMLElement>('[data-dock]')!;
        const capsules = [...dock.querySelectorAll('[data-capsule]')].map((c) => c.getBoundingClientRect());
        return { rows: new Set(capsules.map((r) => Math.round(r.top))).size, widths: capsules.map((r) => r.width), scrolls: dock.scrollWidth > dock.clientWidth };
      });
      assert.deepEqual(row, { rows: 1, widths: [250, 250, 250], scrolls: true });
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await page.hover('[data-capsule][data-session="s-thumbs"] button');
      await holds('no hover card past its delay', 400, async () => !(await page.eval(openCards)).length);
      await shot('narrow-dock');
      await page.click('[data-capsule][data-session="s-thumbs"] button');
      await page.until('the sheet of s-thumbs', () => location.pathname === '/s/s-thumbs/overview' && !!document.querySelector('#task-sheet'));
    },
  },
  {
    name: 'P6.hover-under-sheet a hover card never stays over the sheet: not when the sheet opens while the card shows, nor when it opens before the hover delay runs out, nor from Enter on a capsule the keyboard opened a card for',
    async run({ holds, page, mock }) {
      const open = (path: string) => window.navigation.navigate(path, { state: { base: '/' } }).finished?.catch(() => {});
      const cleared = async () => {
        await page.until('the sheet', sheetOpen);
        await page.until('no hover card', () => !document.querySelector('[data-hovercard]:popover-open'));
        await holds('no hover card past its delay', 400, async () => !(await page.eval(openCards)).length);
        await page.key('Escape');
        await page.until('the sheet to close', () => !document.querySelector('#task-sheet') && location.pathname === '/');
      };
      await page.goto(`${mock.url}/`);
      await page.until('the dock', docked, 3);

      await page.hover('[data-capsule][data-session="s-invoice"] button');
      await page.until('the hover card', hoverCard, 's-invoice');
      await page.eval(open, '/s/s-cart/overview');
      await cleared();

      await page.pointAt(720, 200);
      await page.hover('[data-capsule][data-session="s-search"] button');
      await page.eval(open, '/s/s-cart/overview');
      await cleared();

      await page.pointAt(720, 200);
      await page.eval(() => document.querySelector<HTMLElement>('[data-capsule][data-session="s-invoice"] button')!.focus());
      await page.key('Tab');
      assert.deepEqual(await page.eval(openCards), ['s-search']);
      await page.key('Enter');
      await page.until('the sheet of s-search', () => location.pathname === '/s/s-search/overview');
      await cleared();
    },
  },
  {
    name: 'P6.resting with nothing in the queue / shows the empty queue with the dock of working agents under it, and it stays; the first card that arrives keeps it',
    clock: 'fast',
    scenario: 'zero',
    async run({ holds, page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the empty queue', () => document.querySelector('main h1')?.textContent === 'All caught up.');
      await page.until('the dock', docked, 3);
      await holds('the dock to stay', 2000, () => page.eval(docked, 3));
      await mock.post('/mock/add', { template: 'ask', id: 's-new', rank: 1 });
      await page.until('the new card at the front', frontIs, 's-new');
      assert.equal(await page.eval(docked, 3), true);
    },
  },
  {
    name: 'P6.edge-card the card of a capsule at the right edge of the window, where it cannot open rightwards, opens leftwards from the capsule\'s end and stays inside the window (volume45, no ended pill)',
    scenario: 'volume45',
    async run({ page, mock, look, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the dock', docked, 16);
      const id = await page.eval(() => {
        const capsules = [...document.querySelectorAll<HTMLElement>('[data-dock] [data-capsule]')];
        const right = Math.max(...capsules.map((c) => c.getBoundingClientRect().right));
        return capsules.find((c) => c.getBoundingClientRect().right === right)!.dataset.session!;
      });
      await page.hover(`[data-capsule][data-session="${id}"] button`);
      await page.until('its card', hoverCard, id);
      await page.until('the card to settle', settled);
      const card = (await page.eval(hoverCard, id))!;
      assert.ok(card.capsule.left + (card.box.right - card.box.left) > look.width, 'the card would have fitted rightwards');
      assert.ok(card.inside, 'the card is not inside the window');
      assert.ok(Math.abs(card.box.right - card.capsule.right) < 1, 'the card does not end where its capsule ends');
      assert.ok(card.box.bottom <= card.capsule.top, 'the card is not above its capsule');
      await shot('hover-card-edge');
    },
  },
];
