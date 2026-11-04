import assert from 'node:assert/strict';
import { sleep, until } from '../cdp.ts';
import { card, frame, meterIn, openFromWall, openSheetOf, settled, sheetOpen, tiles, wholeFile, withoutBoard, type Check } from '../helpers.ts';

export const wall: Check[] = [
  {
    name: 'P4.1 the Wall: its title and the queue\'s counts, Back to the queue Esc; tiles in priority order with repo · branch and no rank or line counts; Archived (1) collapsed; working clocks tick; Esc goes to the queue and V back; a menu answered from the board that stays open turns Needs focus by the clock alone',
    async run({ page, mock, shot }) {
      const wall = () => ({
        title: document.querySelector('main h1')?.textContent,
        sub: document.querySelector('main h1 + p')?.textContent,
        back: document.querySelector('main a[href="/"]')?.textContent,
        order: [...document.querySelectorAll<HTMLElement>('[data-tile]')].filter((t) => !t.closest('details')).map((t) => `${t.dataset.session} ${t.dataset.attention}`),
        archived: document.querySelector('main details > summary')?.textContent,
        open: document.querySelector<HTMLDetailsElement>('main details')?.open,
        texts: Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-tile]')].map((t) => [t.dataset.session, t.innerText])) as Record<string, string>,
      });
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      const shown = await page.eval(wall);
      assert.deepEqual({ ...shown, texts: undefined }, {
        title: 'Every agent, in priority order',
        sub: '3 decisions · 1 terminal prompt · 2 finished turns wait in the queue.',
        back: 'Back to the queue Esc',
        order: [
          's-cart decide', 's-hooks decide', 's-group decide', 's-astro focus', 's-reviews idle', 's-anchors idle',
          's-invoice working', 's-search working', 's-thumbs working', 's-split exited', 's-stripe exited',
        ],
        archived: 'Archived (1)',
        open: false,
        texts: undefined,
      });
      for (const [id, text] of Object.entries(shown.texts)) {
        assert.doesNotMatch(text, /#\d|(^|\s)[+−]\d/, `${id} shows a rank or a line count`);
      }
      assert.match(shown.texts['s-cart'], /storefront · guest-cart-merge/);
      assert.match(shown.texts['s-invoice'], /billing-api · invoice-rounding/);
      const clock = () => document.querySelector('[data-tile][data-session="s-invoice"] [data-explain="How long the turn has run"]')?.textContent;
      const first = await page.eval(clock);
      await sleep(1100);
      const second = await page.eval(clock);
      assert.match(first ?? '', /^\d+:\d\d$/);
      assert.notEqual(second, first, 'the working clock did not tick');
      await shot('wall');

      await page.key('Escape');
      await page.until('the queue', () => location.pathname === '/' && document.documentElement.dataset.view === 'queue' && !!document.querySelector('[data-card]'));
      await page.key('v');
      await page.until('the Wall again', () => location.pathname === '/wall' && document.documentElement.dataset.view === 'wall');

      const hooks = () => [document.querySelector('[data-tile][data-session="s-hooks"]')?.getAttribute('data-attention'), document.title];
      await mock.post('/mock/patch', { id: 's-hooks', patch: { answered: { key: 'm:toolu_01Hooks', text: 'Backoff: Exponential, 5 tries', at: Date.now() - 8000 } } });
      await page.until('the answered menu to count as working', () => document.querySelector('[data-tile][data-session="s-hooks"]')?.getAttribute('data-attention') === 'working');
      assert.deepEqual(await page.eval(hooks), ['working', 'Pitwall']);
      await page.until('the menu still open to need focus', () => document.querySelector('[data-tile][data-session="s-hooks"]')?.getAttribute('data-attention') === 'focus');
      assert.deepEqual(await page.eval(hooks), ['focus', 'Pitwall']);
    },
  },
  {
    name: 'P4.2 the top bar: Live, and a tab title without a count; six meter segments whose counts are only in the aria-label, then the usage limits, Repos, the view toggle and New task; before the first snapshot the pill reads Connecting… and every view says so',
    expectedErrors: [/WebSocket/],
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the card', card);
      const bar = await page.eval(() => {
        const left = (s: string) => document.querySelector(s)?.getBoundingClientRect().left ?? NaN;
        const right = (s: string) => document.querySelector(s)?.getBoundingClientRect().right ?? NaN;
        const pill = document.querySelector<HTMLElement>('[data-link]');
        return {
          link: [pill?.dataset.link, pill?.innerText.trim()],
          title: document.title,
          segments: document.querySelectorAll('[data-segment]').length,
          label: document.querySelector('[data-meter] [role="group"]')?.getAttribute('aria-label'),
          // The usage limits are shares of the plan, not counts of cards.
          shown: [...document.querySelector<HTMLElement>('header')!.querySelectorAll<HTMLElement>(':scope > div')].map((d) => {
            const c = d.cloneNode(true) as HTMLElement;
            c.querySelector('[data-usage]')?.remove();
            return c.textContent;
          }).join(' '),
          order: right('[data-meter] [role="group"]') <= left('[data-usage]') && right('[data-usage]') <= left('[data-repos]') && left('[data-repos]') < left('nav[aria-label="View"]') &&
            left('nav[aria-label="View"]') < left('button[aria-label="New task"]'),
        };
      });
      assert.deepEqual({ ...bar, shown: undefined }, {
        link: ['live', 'Live'], title: 'Pitwall', segments: 6, label: '3 decisions · 1 terminal prompt · 2 finished turns', shown: undefined, order: true,
      });
      assert.doesNotMatch(bar.shown ?? '', /\d/, 'the top bar shows a count');
      await shot('top-bar');

      await withoutBoard(async (url) => {
        for (const path of ['/', '/wall', '/s/s-cart/overview']) {
          await page.goto(`${url}${path}`);
          await sleep(300);
          const before = await page.eval(() => ({
            link: document.querySelector<HTMLElement>('[data-link]')?.dataset.link,
            text: document.querySelector<HTMLElement>('[data-link]')?.innerText.trim(),
            view: [...document.querySelectorAll<HTMLElement>('main, #task-sheet')].map((v) => v.innerText.trim()).at(-1),
          }));
          assert.deepEqual(before, { link: 'connecting', text: 'Connecting…', view: 'Connecting…' }, path);
        }
        await shot('connecting');
      });
    },
  },
  {
    name: 'P4.3 the meter at volume: 24 and 45 cards keep it clear of the wordmark and Repos at 1440 and 1100 px, 45 draw bars of 30, 5 and 10; 20 cards at 1100 px keep every segment 6 px or wider; counts stay in the aria-label, and an arrival shows the Just-in chip, short where the slot is narrow',
    scenario: 'volume',
    async run({ page, mock, look, shot }) {
      const load = async (scenario: string, ready: (inFrame: boolean) => boolean) => {
        await mock.post(`/mock/scenario/${scenario}`);
        await page.goto(`${mock.url}/`);
        await page.until(`${scenario} in the meter`, ready, false);
        await page.eval(frame, '/', 1100, 900);
        await page.until(`${scenario} in the meter at 1100 px`, ready, true);
        return [await page.eval(meterIn, false), await page.eval(meterIn, true)];
      };
      const bars = (inFrame: boolean) => {
        const doc = inFrame ? (document.getElementById('e2e-frame') as HTMLIFrameElement).contentDocument : document;
        return doc?.querySelectorAll('[data-bar]').length === 3;
      };
      const twenty = (inFrame: boolean) => {
        const doc = inFrame ? (document.getElementById('e2e-frame') as HTMLIFrameElement).contentDocument : document;
        return doc?.querySelectorAll('[data-segment]').length === 20;
      };

      for (const [wide, at1100] of [await load('volume', bars)]) {
        for (const m of [wide, at1100]) {
          assert.deepEqual([m.overlap, m.label, m.shown, m.justIn], [false, '14 decisions · 3 terminal prompts · 7 finished turns', '14\n3\n7', []]);
        }
      }
      await shot('meter-volume-1100');
      await page.eval(() => document.getElementById('e2e-frame')?.remove());
      await shot('meter-volume');

      for (const m of await load('volume45', bars)) {
        assert.deepEqual([m.overlap, m.bars, m.label], [false, ['30', '5', '10'], '30 decisions · 5 terminal prompts · 10 finished turns']);
      }
      await page.eval(() => document.getElementById('e2e-frame')?.remove());
      await shot('meter-volume45');

      const [wide, narrow] = await load('volume20', twenty);
      for (const m of [wide, narrow]) {
        assert.deepEqual([m.overlap, m.label, m.shown, m.justIn], [false, '12 decisions · 3 terminal prompts · 5 finished turns', '', []]);
        assert.ok(m.segments.every((w) => w >= 6), `segments ${m.segments.join(', ')}`);
      }
      await mock.post('/mock/add', { template: 'ask', id: 's-new', rank: 2 });
      await page.until('the Just-in chip at 1100 px', () =>
        !!(document.getElementById('e2e-frame') as HTMLIFrameElement).contentDocument?.querySelector('[data-justin]'));
      assert.deepEqual((await page.eval(meterIn, true)).justIn, ['Just in']);
      assert.deepEqual((await page.eval(meterIn, false)).justIn, [look.width > 1100 ? 'Just in: Retire the v1 orders API' : 'Just in']);
      await shot('meter-just-in-1100');
    },
  },
  {
    name: 'P4.4 a tile opens its sheet on Overview, which takes focus itself: the working banner with a 30 px clock that ticks, the composer, Session summary · updated, Worth knowing, the latest reply with its code in colour, Facts with the repository, the worktree\'s name and its path under ~, whose Path, Branch and Session copy on a click (the path whole) and say Copied in place, Worth knowing and the reply copy from their heading, and the Artifacts links; Esc in the composer\'s command list closes only the list',
    clock: 'fast',
    async run({ wait, page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await page.click('[data-tile][data-session="s-invoice"] p');
      await page.until('the sheet', sheetOpen);
      assert.deepEqual(await page.eval(() => [location.pathname, document.activeElement?.id]), ['/s/s-invoice/overview', 'task-sheet']);
      const clock = () => {
        const c = document.querySelector<HTMLElement>('#task-sheet [data-explain="Time since your last message"]');
        return c && { text: c.textContent, size: getComputedStyle(c).fontSize };
      };
      const first = await page.until('the working banner', clock);
      await page.until('the code in the reply in colour', () =>
        [...document.querySelectorAll<HTMLElement>('#task-sheet pre code span')].find((s) => s.textContent === 'const')?.style.color.startsWith('light-dark('));
      const overview = await page.eval(() => {
        const sheet = document.querySelector<HTMLElement>('#task-sheet')!;
        return {
          working: sheet.innerText.includes('Claude is working'),
          know: sheet.innerText.includes('Two customers were billed one cent too much'),
          composer: !!sheet.querySelector('textarea'),
          status: [...sheet.querySelectorAll('h3')].map((h) => h.textContent).find((t) => t?.startsWith('Session summary')),
          reply: sheet.innerText.includes("CLAUDE'S LATEST REPLY") && sheet.innerText.includes('The cent goes missing'),
          facts: [...sheet.querySelectorAll('dt')].map((d) => d.textContent),
          values: Object.fromEntries([...sheet.querySelectorAll('dt')].map((d) => [d.textContent, (d.nextElementSibling as HTMLElement).innerText.trim()])),
          artifacts: [...sheet.querySelectorAll('aside button strong')].map((b) => b.textContent),
        };
      });
      assert.equal(first.size, '30px');
      assert.deepEqual([overview.values.Repository, overview.values.Worktree, overview.values.Path], ['billing-api', 'invoice-rounding', '~/code/worktrees/invoice-rounding/billing-api']);
      assert.deepEqual({ ...overview, status: undefined, values: undefined }, {
        working: true, know: true, composer: true, status: undefined, values: undefined, reply: true,
        facts: ['Task', 'Repository', 'Worktree', 'Path', 'Branch', 'Model', 'Terminal', 'Session'], artifacts: ['Where the cent goes missing'],
      });
      assert.match(overview.status ?? '', /^Session summary · updated \d+m ago$/);
      await wait(1100);
      assert.notEqual((await page.eval(clock))?.text, first.text, 'the clock did not tick');
      await page.until('the sheet to settle', settled);
      await shot('sheet-overview');

      await page.eval(() => {
        const w = window as unknown as { copied: string[] };
        w.copied = [];
        navigator.clipboard.writeText = async (t: string) => void w.copied.push(t);
      });
      for (const fact of ['Path', 'Branch', 'Session']) {
        await page.eval((f) => [...document.querySelectorAll<HTMLElement>('#task-sheet dt')].find((d) => d.textContent === f)!.nextElementSibling!.querySelector('button')!.click(), fact);
      }
      await page.until('all three marked Copied', () => [...document.querySelectorAll('#task-sheet dd button[data-copied]')].map((b) => b.textContent?.endsWith('Copied')).join() === 'true,true,true');
      const copied = await page.eval(() => (window as unknown as { copied: string[] }).copied);
      assert.deepEqual(copied, [`${await mock.home()}/code/worktrees/invoice-rounding/billing-api`, 'invoice-rounding', 's-invoice']);
      await shot('sheet-facts-copied');

      await page.eval(() => {
        for (const what of ['Copy worth knowing', 'Copy reply']) document.querySelector<HTMLElement>(`#task-sheet h3 button[aria-label="${what}"]`)!.click();
      });
      await page.until('Worth knowing and the reply copied', () => (window as unknown as { copied: string[] }).copied.length === 5);
      await shot('sheet-reply-copied');
      const state = await mock.get('/api/state');
      const invoice = state.sessions.find((x: { id: string }) => x.id === 's-invoice');
      assert.deepEqual((await page.eval(() => (window as unknown as { copied: string[] }).copied)).slice(3), [invoice.summary.learnings.join('\n\n'), invoice.lastMessage]);

      await page.click('#task-sheet textarea');
      await page.type('/re');
      await page.until('the command list', () => document.querySelectorAll('#task-sheet [role="listbox"] [role="option"]').length > 0);
      await page.key('Escape');
      await page.until('the list to close', () => !document.querySelector('#task-sheet [role="listbox"]'));
      assert.deepEqual(await page.eval(() => [!!document.querySelector('#task-sheet'), document.querySelector<HTMLTextAreaElement>('#task-sheet textarea')?.value]), [true, '/re']);
    },
  },
  {
    name: 'P4.4.1 background work shows on the task page: listed under the step while the turn runs, and once the turn ends the banner waits on it',
    async run({ page, mock, shot }) {
      const banner = (head: string) => {
        const b = document.querySelector<HTMLElement>('#task-sheet [aria-label="In the background"]')?.closest('section');
        return b?.querySelector('strong')?.textContent === head
          ? { items: [...b.querySelectorAll('li')].map((l) => l.textContent), step: b.querySelector(':scope div > code')?.textContent ?? null }
          : null;
      };
      await openFromWall(page, mock, 's-invoice');
      await page.until('the sheet to settle', settled);
      const since = Date.now() - 60_000;
      const background = ['Bash · Run full e2e suite', 'Agent · Review the diff'];
      await mock.post('/mock/patch', { id: 's-invoice', patch: { activity: { step: 'Bash: pnpm test invoices --run', since, background } } });
      assert.deepEqual(await page.until('the background list', banner, 'Claude is working'), { items: background, step: 'Bash: pnpm test invoices --run' });
      await shot('sheet-working-background');
      await mock.post('/mock/patch', { id: 's-invoice', patch: { activity: { step: 'In the background · Bash · Run full e2e suite and 1 more', since, background, between: true } } });
      assert.deepEqual(await page.until('the wait on background work', banner, 'Waiting on background work'), { items: background, step: null });
      await shot('sheet-between-background');
    },
  },
  {
    name: 'P4.4.2 Claude\'s latest reply on Overview shows the prompt it answers above it, cut to three lines until Show all; a task whose prompt is unknown shows the reply alone; a long reply shows whole, with nothing to fold it',
    async run({ page, mock, shot }) {
      const reply = () => {
        const section = [...document.querySelectorAll<HTMLElement>('#task-sheet section')].find((s) => s.querySelector('h3')?.textContent === "Claude's latest reply");
        const asked = section?.querySelector<HTMLElement>('[data-prompt] p');
        return section ? { prompt: asked?.textContent ?? null, lines: asked ? Math.round(asked.getBoundingClientRect().height / parseFloat(getComputedStyle(asked).lineHeight)) : 0, more: section.querySelector('[data-prompt] button')?.textContent ?? null } : null;
      };
      await openSheetOf(page, mock, 's-invoice');
      assert.deepEqual(await page.until('the latest reply', reply), { prompt: 'Why is the total a cent off on some invoices? Fix it and push.', lines: 1, more: null });
      await shot('latest-reply-prompt');

      const long = Array.from({ length: 8 }, (_, i) => `Point ${i + 1} of what I want.`).join('\n');
      await mock.post('/mock/patch', { id: 's-invoice', patch: { lastPrompt: long, lastMessage: 'Done.' } });
      const cut = await page.until('the long prompt cut', (text: string) => {
        const section = [...document.querySelectorAll<HTMLElement>('#task-sheet section')].find((s) => s.querySelector('h3')?.textContent === "Claude's latest reply");
        const asked = section?.querySelector<HTMLElement>('[data-prompt] p');
        return asked?.textContent === text ? Math.round(asked.getBoundingClientRect().height / parseFloat(getComputedStyle(asked).lineHeight)) : null;
      }, long);
      assert.equal(cut, 3);
      await page.click('#task-sheet section button', 'Show all');
      assert.equal((await page.eval(reply))!.lines, 8);

      await mock.post('/mock/patch', { id: 's-invoice', patch: { lastPrompt: null, lastMessage: 'Pushed again.' } });
      assert.deepEqual(await page.until('the reply alone', () => {
        const section = [...document.querySelectorAll<HTMLElement>('#task-sheet section')].find((s) => s.querySelector('h3')?.textContent === "Claude's latest reply");
        return section?.innerText.includes('Pushed again.') ? (section.querySelector('[data-prompt]') ? 'with a prompt' : 'alone') : null;
      }), 'alone');

      const essay = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of the reply.`).join('\n\n');
      await mock.post('/mock/patch', { id: 's-invoice', patch: { lastPrompt: null, lastMessage: essay } });
      assert.deepEqual(await page.until('the long reply whole', () => {
        const section = [...document.querySelectorAll<HTMLElement>('#task-sheet section')].find((s) => s.querySelector('h3')?.textContent === "Claude's latest reply");
        const body = section?.querySelector<HTMLElement>(':scope > div');
        return body?.innerText.includes('Paragraph 40') ? { clipped: body.scrollHeight > body.clientHeight, buttons: section!.querySelectorAll('[data-prompt] button').length } : null;
      }), { clipped: false, buttons: 0 });
    },
  },
  {
    name: 'P4.5 Diff: 2 replaces the entry; the tree resizes by key and resets on a double click, kept in localStorage; a file opens whole, J and K step, All files in the tree goes back; Esc goes back to all files, a second Esc closes the sheet and focus returns to the tile\'s name',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await page.eval(() => document.querySelector<HTMLElement>('[data-tile][data-session="s-invoice"] a')!.focus());
      await page.key('Enter');
      await page.until('the sheet', sheetOpen);
      const entries = await page.eval(() => window.navigation.entries().length);
      await page.key('3');
      await page.until('the file tree', () => location.pathname === '/s/s-invoice/diff' && document.querySelectorAll('nav[aria-label="Changed files"] a').length === 12);
      assert.equal(await page.eval(() => window.navigation.entries().length), entries, 'the tab pushed an entry');
      await page.until('the diff', () => document.querySelectorAll('section[data-file] diffs-container').length > 0);
      await shot('sheet-diff');

      const width = () => ({
        now: document.querySelector('[role="separator"]')?.getAttribute('aria-valuenow'),
        kept: localStorage.getItem('diff-tree-width'),
      });
      await page.eval(() => document.querySelector<HTMLElement>('[role="separator"]')!.focus());
      await page.key('ArrowRight');
      await page.key('ArrowRight');
      assert.deepEqual(await page.eval(width), { now: '292', kept: '292' });
      await page.key('ArrowLeft');
      assert.deepEqual(await page.eval(width), { now: '276', kept: '276' });
      await page.eval(() => document.querySelector('[role="separator"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
      assert.deepEqual(await page.eval(width), { now: '260', kept: '260' });

      await page.click('nav[aria-label="Changed files"] a[data-explain="server/git.ts"]');
      await page.until('server/git.ts whole', wholeFile, 'server/git.ts');
      await page.key('j');
      await page.until('the next file whole', wholeFile, 'server/mcpGuard.test.ts');
      await page.key('k');
      await page.until('the file before whole', wholeFile, 'server/git.ts');
      await shot('sheet-diff-file');

      await page.click('nav[aria-label="Changed files"] > button');
      await page.until('all files from the tree', () => document.querySelectorAll('section[data-file]').length === 12 &&
        document.querySelector('nav[aria-label="Changed files"] > button')?.getAttribute('aria-pressed') === 'true');
      await page.click('nav[aria-label="Changed files"] a[data-explain="server/git.ts"]');
      await page.until('server/git.ts whole again', wholeFile, 'server/git.ts');

      await page.key('Escape');
      await page.until('all files again', () => document.querySelectorAll('section[data-file]').length === 12);
      assert.equal(await page.eval(sheetOpen), true, 'Esc in one file closed the sheet');
      await page.key('Escape');
      await page.until('the sheet to close', () => !document.querySelector('#task-sheet') && location.pathname === '/wall');
      assert.equal(await page.eval(() => document.activeElement?.closest('[data-tile]')?.getAttribute('data-session') + ' ' + document.activeElement?.tagName), 's-invoice A');
    },
  },
  {
    name: 'P4.5b Diff: a folder in the tree shows only its files, with their count and ± in the toolbar; a file in it opens whole and Esc goes back to the folder, then to all files',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-cart/diff`);
      await page.until('every file', () => document.querySelectorAll('section[data-file]').length === 12);
      const view = () => ({
        sections: [...document.querySelectorAll('section[data-file]')].map((s) => s.getAttribute('data-file')),
        toolbar: document.querySelector('[data-theme="dark"] > div')?.textContent ?? '',
        current: [...document.querySelectorAll('nav[aria-label="Changed files"] [aria-current], nav[aria-label="Changed files"] [aria-pressed="true"]')].map((e) => e.textContent?.trim()),
      });

      await page.click('nav[aria-label="Changed files"] button[data-explain="Show only the changes in web/src/"]');
      await page.until('web/src alone', () => document.querySelectorAll('section[data-file]').length === 2);
      const folder = await page.eval(view);
      assert.deepEqual(folder.sections, ['web/src/components/MenuCard.tsx', 'web/src/types.ts']);
      assert.match(folder.toolbar, /← All filesweb\/src\/2 files · \+2 −6/);
      assert.ok(folder.current.includes('web/src'), `the folder is not current: ${folder.current}`);
      assert.ok(!folder.current.some((c) => c?.startsWith('All files')), 'All files is still pressed');
      await shot('diff-folder');

      await page.click('nav[aria-label="Changed files"] a[data-explain="web/src/types.ts"]');
      await page.until('types.ts whole', wholeFile, 'web/src/types.ts');
      assert.match(await page.eval(() => document.querySelector('[data-theme="dark"] > div button')?.textContent ?? ''), /^← web\/src\/$/);
      await page.key('j');
      await page.until('J stays in the folder', wholeFile, 'web/src/types.ts');
      await page.key('k');
      await page.until('K steps to the file before in the folder', wholeFile, 'web/src/components/MenuCard.tsx');
      await page.key('Escape');
      await page.until('back to the folder', () => document.querySelectorAll('section[data-file]').length === 2);
      await page.key('Escape');
      await page.until('back to all files', () => document.querySelectorAll('section[data-file]').length === 12 &&
        document.querySelector('nav[aria-label="Changed files"] > button')?.getAttribute('aria-pressed') === 'true');
      assert.ok(await page.eval(() => !!document.querySelector('#task-sheet') || location.pathname === '/s/s-cart/diff'), 'Esc left the diff');

      await page.click('nav[aria-label="Changed files"] button[data-explain="Show only the changes in server/"]');
      await page.until('server alone', () => document.querySelectorAll('section[data-file]').length === 8);
      await page.click('nav[aria-label="Changed files"] > button');
      await page.until('all files from the tree', () => document.querySelectorAll('section[data-file]').length === 12);
    },
  },
  {
    name: 'P4.5u the task page marks commits only origin has: no mark with no upstream, the same commits or only commits not pushed; a small mark explains the commits and files origin has, and after a rewrite of origin the files the PR has against this checkout, linking to the PR\'s files; the Diff tab reads it again',
    async run({ page, mock, shot }) {
      const worktree = `${await mock.home()}/code/worktrees/guest-cart-merge/storefront`;
      const up = (state: string, more: Record<string, unknown> = {}) => mock.post('/mock/upstream', {
        worktree, upstream: { upstream: 'origin/guest-cart-merge', state, ahead: 0, behind: 0, behindFiles: 0, branchFiles: null, fetchFailed: false, ...more },
      });
      const line = (state: string | null) => {
        const el = document.querySelector('#task-sheet [data-upstream]');
        if (state && el?.getAttribute('data-upstream') !== state) return null;
        return el && { state: el.getAttribute('data-upstream'), text: el.textContent, explain: el.getAttribute('data-explain'), href: el.getAttribute('href') };
      };
      const reads = async () => (await mock.log()).filter((e) => e.path === '/api/upstream' && e.status !== null).length;
      const open = async () => {
        await page.goto('about:blank');
        await mock.get('/mock/log?clear=1');
        await page.goto(`${mock.url}/s/s-cart`);
        await page.until('the sheet', sheetOpen);
        await until('the upstream read', async () => (await reads()) > 0 || null);
      };

      await open();
      assert.equal(await page.eval(line, null), null, 'a line with no upstream');
      await up('same');
      await open();
      assert.equal(await page.eval(line, null), null, 'a line with the same commits');

      await up('ahead', { ahead: 2 });
      await open();
      assert.equal(await page.eval(line, null), null, 'a mark with only commits not pushed');

      await up('behind', { behind: 1, behindFiles: 3 });
      await mock.get('/mock/log?clear=1');
      await page.key('3');
      assert.deepEqual(await page.until('the behind line on opening the Diff', line, 'behind'), {
        state: 'behind', text: '↓ origin', explain: 'origin/guest-cart-merge has 1 commit this checkout does not, changing 3 files.', href: null,
      });
      assert.equal(await reads(), 1, 'opening the Diff reads the upstream once');

      await mock.post('/mock/patch', { id: 's-cart', patch: { prs: [{ id: 23914, url: 'https://dev.azure.com/acme/shop/_git/storefront/pullrequest/23914', repo: null, result: null, watching: false, at: Date.now() }] } });
      await up('diverged', { ahead: 6, behind: 113, behindFiles: 1035, branchFiles: 84, fetchFailed: true });
      await open();
      const files = (await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === 's-cart').diffstat.files;
      assert.deepEqual(await page.until('the diverged line', line, 'diverged'), {
        state: 'diverged',
        text: '↓ origin',
        explain: `origin/guest-cart-merge was rewritten, as by a force-push: this checkout's 6 commits are no longer on it. The PR has 84 files, this checkout ${files} files; the Diff shows this checkout.\nFetching origin/guest-cart-merge failed, so this is as of the last fetch.\nOpens the PR's changed files.`,
        href: 'https://dev.azure.com/acme/shop/_git/storefront/pullrequest/23914?_a=files',
      });
      await shot('sheet-upstream-diverged');
    },
  },
  {
    name: 'P4.5c Diff: the tree\'s filter keeps the files whose path holds every word typed, in the tree and the diff, with their count and ± in the toolbar; J and K stay among them; a folder narrows them further; Esc in the field clears it, then leaves it, keeping the task open',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-cart/diff`);
      await page.until('every file', () => document.querySelectorAll('section[data-file]').length === 12);
      const view = () => ({
        sections: [...document.querySelectorAll('section[data-file]')].map((s) => s.getAttribute('data-file')),
        tree: [...document.querySelectorAll('nav[aria-label="Changed files"] a')].map((a) => a.getAttribute('data-explain')),
        all: document.querySelector('nav[aria-label="Changed files"] > button')?.textContent ?? '',
        toolbar: document.querySelector('[data-theme="dark"] > div')?.textContent ?? '',
      });
      const filter = 'nav[aria-label="Changed files"] input[type="search"]';

      await page.click(filter);
      await page.type('MENU');
      await page.until('the menu files', () => document.querySelectorAll('section[data-file]').length === 3);
      const menu = await page.eval(view);
      const menuFiles = ['server/menu.test.ts', 'server/menu.ts', 'web/src/components/MenuCard.tsx'];
      assert.deepEqual(menu.sections, menuFiles);
      assert.deepEqual(menu.tree, menuFiles);
      assert.equal(menu.all, 'All files 3 of 12');
      assert.match(menu.toolbar, /3 of 12 files match · \+87 −6/);
      await shot('diff-filter');

      await page.type(' test');
      await page.until('menu test alone', () => document.querySelectorAll('section[data-file]').length === 1);
      assert.deepEqual((await page.eval(view)).sections, ['server/menu.test.ts']);
      await page.type('zzz');
      await page.until('nothing matches', () => !document.querySelector('section[data-file]'));
      assert.match(await page.eval(() => document.querySelector('[data-theme="dark"]')?.textContent ?? ''), /No file matches\..*No changed file matches “MENU testzzz”\./);

      await page.key('Escape');
      await page.until('the filter cleared', () => document.querySelectorAll('section[data-file]').length === 12);
      assert.equal(await page.eval((sel) => document.querySelector<HTMLInputElement>(sel)?.value, filter), '');
      assert.ok(await page.eval((sel) => document.activeElement === document.querySelector(sel), filter), 'the first Esc left the field');
      await page.key('Escape');
      assert.ok(await page.eval((sel) => document.activeElement !== document.querySelector(sel), filter), 'the second Esc stayed in the field');
      assert.equal(await page.eval(() => location.pathname), '/s/s-cart/diff');

      await page.click(filter);
      await page.type('menu');
      await page.until('the menu files', () => document.querySelectorAll('section[data-file]').length === 3);
      await page.click('nav[aria-label="Changed files"] a[data-explain="server/menu.ts"]');
      await page.until('menu.ts whole', wholeFile, 'server/menu.ts');
      await page.key('j');
      await page.until('J steps to the next match', wholeFile, 'web/src/components/MenuCard.tsx');
      await page.key('j');
      await page.until('J stays on the last match', wholeFile, 'web/src/components/MenuCard.tsx');
      await page.key('Escape');
      await page.until('back to the matches', () => document.querySelectorAll('section[data-file]').length === 3);

      await page.click('nav[aria-label="Changed files"] button[data-explain="Show only the changes in server/"]');
      await page.until('the menu files in server/', () => document.querySelectorAll('section[data-file]').length === 2);
      assert.match((await page.eval(view)).toolbar, /server\/2 files match/);
    },
  },
  {
    name: 'P4.5d Diff: a large diff, 120 files, draws only the files near the part in view and the rest as it scrolls to them; a file opened from far down goes back to all files drawn where it was',
    async run({ page, mock }) {
      // The page's own fetch gives ten copies of the fixture's diff, each under a folder of its own.
      await page.initScript(`(${() => {
        const real = window.fetch.bind(window);
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const res = await real(input, init);
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.pathname !== '/api/diff') return res;
          const d = await res.json();
          const copy = (n: number) => d.patch.replace(/^(diff --git a\/)(.*) b\/(.*)$/gm, `$1copy${n}/$2 b/copy${n}/$3`).replace(/^(---|\+\+\+) ([ab])\//gm, `$1 $2/copy${n}/`);
          const patch = Array.from({ length: 10 }, (_, n) => copy(n)).join('');
          return new Response(JSON.stringify({ ...d, patch, stat: { ...d.stat, files: d.stat.files * 10 } }), { headers: { 'content-type': 'application/json' } });
        };
      }})()`);
      await openFromWall(page, mock, 's-invoice');
      await page.key('3');
      await page.until('every file listed', () => document.querySelectorAll('section[data-file]').length === 120);
      const drawn = () => [...document.querySelectorAll<HTMLElement>('section[data-file]')].filter((s) => s.querySelector('diffs-container')).map((s) => s.dataset.file!);
      await sleep(300);
      const first = await page.eval(drawn);
      assert.ok(first.length >= 12 && first.length < 60, `${first.length} files drawn at once`);
      assert.ok(first.includes((await page.eval(() => document.querySelector<HTMLElement>('section[data-file]')!.dataset.file))!), 'the first file is not drawn');

      const last = await page.eval(() => [...document.querySelectorAll<HTMLElement>('section[data-file]')].at(-1)!.dataset.file!);
      assert.ok(!first.includes(last), 'the last file was drawn at once');
      await page.eval(() => {
        const list = document.querySelector('section[data-file]')!.parentElement!;
        list.scrollTop = list.scrollHeight;
      });
      await page.until('the last file drawn', (last: string) => !!document.querySelector(`section[data-file="${last}"] diffs-container`)?.shadowRoot?.querySelector('pre'), last);

      await page.click(`nav[aria-label="Changed files"] a[data-explain="${last}"]`);
      await page.until('the last file whole', wholeFile, last);
      await page.key('Escape');
      await page.until('all files again', () => document.querySelectorAll('section[data-file]').length === 120);
      assert.equal(await page.eval((last: string) => !!document.querySelector(`section[data-file="${last}"] diffs-container`), last), true, 'the file gone back to was not drawn');
    },
  },
];
