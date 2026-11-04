import assert from 'node:assert/strict';
import { until } from '../cdp.ts';
import { connection, edgeLine, logged, luminance, openQueue, openSheetOf, POSTED_MS, reachable, ready, sidewaysScroll, wholeFile, type Check } from '../helpers.ts';

export const board: Check[] = [
  {
    name: 'P0.2 board: 11 tiles, Archived (1) collapsed, title (3); an option on the card answers once and the tile turns working',
    clock: 'fast',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      const board = await page.eval(() => ({
        tiles: [...document.querySelectorAll('[data-tile]')].filter((t) => !t.closest('details')).length,
        archived: document.querySelector('details > summary')?.textContent,
        open: document.querySelector('details')?.open,
        title: document.title,
      }));
      assert.deepEqual(board, { tiles: 11, archived: 'Archived (1)', open: false, title: 'Pitwall' });
      await shot('board');

      await openQueue(page, mock);
      await ready(page, 's-cart');
      await shot('task-ask');
      await page.click('[data-card] [data-option]', 'Keep the account cart');
      const answers = await logged(mock, 'the answer', (e) => e.action === 'answer', POSTED_MS);
      assert.equal(answers.length, 1);
      const [a] = answers;
      assert.deepEqual([a.sessionId, a.body.key, a.body.choice, a.status], ['s-cart', 'q:toolu_01Cart', 'Keep the account cart', 204]);

      await page.goto(`${mock.url}/wall`);
      await page.until('the s-cart tile to turn working', () => document.querySelector('[data-tile][data-session="s-cart"]')?.getAttribute('data-attention') === 'working');
      assert.equal((await mock.log()).filter((e) => e.action === 'answer').length, 1);
      assert.equal(await page.eval(() => document.title), 'Pitwall');
      await shot('board-answered');
    },
  },
  {
    name: 'P0.3 a refused answer (/mock/fail, stale) says why in a toast: Not sent to Retry failed webhooks: this question is no longer open',
    clock: 'fast',
    expectedErrors: [/status of 400/],
    async run({ page, mock, shot }) {
      await mock.post('/mock/fail', { error: 'this question is no longer open', code: 'stale' });
      await openQueue(page, mock);
      await page.key('ArrowRight');
      await ready(page, 's-hooks');
      await page.key('6');
      await page.until('Disable the endpoint unpicked', () => document.querySelector('[data-card] [data-option="6"]')?.getAttribute('aria-pressed') === 'false');
      await shot('task-menu');
      await page.click('[data-card] [data-primary]');
      const toast = await until('the error toast', () => page.eval(() => [...document.querySelectorAll<HTMLElement>('[data-toast][data-kind="error"]')].map((t) => t.innerText.trim()).join('\n')), POSTED_MS);
      assert.equal(toast, 'Not sent to Retry failed webhooks: this question is no longer open\nShow');
      const [sent] = await logged(mock, 'the menu answer', (e) => e.action === 'answer-menu');
      assert.deepEqual([sent.sessionId, sent.status, sent.code, sent.body.toolUseId], ['s-hooks', 400, 'stale', 'toolu_01Hooks']);
      assert.deepEqual(sent.body.answers, [{ labels: ['Exponential, 5 tries'], other: '' }, { labels: ['Email the account owner'], other: '' }]);
      await shot('toast-refused');
    },
  },
  {
    name: 'P0.4 diff: the fixture patch (12 files from ff30c77) renders split and dark, long lines wrapped; a file in the tree opens whole',
    async run({ holds, themes, page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-cart/diff`);
      const files = await page.until('the file tree', () => document.querySelectorAll('nav[aria-label="Changed files"] a').length);
      assert.equal(files, 12);
      // An added file has no old side to show, so "split" means every modified file shows both.
      const layout = await page.until('every file rendered', () => {
        const rendered = [...document.querySelectorAll('section[data-file]')].map((s) => ({
          file: s.getAttribute('data-file'),
          type: s.querySelector('diffs-container')?.shadowRoot?.querySelector('pre[data-diff-type]')?.getAttribute('data-diff-type'),
        }));
        const modified = [...document.querySelectorAll('nav[aria-label="Changed files"] a:has([data-type="change"])')].map((a) => a.getAttribute('data-explain'));
        return rendered.length === 12 && rendered.every((r) => r.type) && { modified: modified.toSorted((a, b) => (a! < b! ? -1 : a! > b! ? 1 : 0)), split: rendered.filter((r) => r.type === 'split').map((r) => r.file).toSorted((a, b) => (a! < b! ? -1 : a! > b! ? 1 : 0)) };
      });
      await themes(async (scheme) => {
        const view = await page.eval(() => ({
          toolbar: document.querySelector('[data-theme="dark"] > div')?.textContent ?? '',
          background: getComputedStyle(document.querySelector('[data-theme="dark"]')!).backgroundColor,
        }));
        assert.match(view.toolbar, /12 files · \+368 −55 against origin\/main/);
        assert.ok(luminance(view.background) < 0.05, `the diff background ${view.background} is not dark in ${scheme}`);
      });
      assert.equal(layout.modified.length, 7);
      assert.deepEqual(layout.split, layout.modified);
      const sideways = await page.eval(() => [...document.querySelectorAll('section[data-file]')].flatMap((s) => {
        const pre = s.querySelector('diffs-container')?.shadowRoot?.querySelectorAll<HTMLElement>('pre, [data-code]') ?? [];
        return [...pre].filter((p) => p.scrollWidth > p.clientWidth + 1).map(() => s.getAttribute('data-file'));
      }));
      assert.deepEqual(sideways, [], 'a line too long for its side wraps rather than scrolling sideways');
      await shot('diff');

      // Every frame from the click on, the one file as shown: its lines and where the pane is scrolled to.
      await page.eval(() => {
        const seen: string[] = [];
        (window as unknown as { seen: string[] }).seen = seen;
        const record = () => {
          const pane = document.querySelector<HTMLElement>('section[data-file]')?.parentElement;
          const sections = document.querySelectorAll('section[data-file]');
          if (pane && sections.length === 1 && !pane.hasAttribute('data-seeking')) {
            const lines = sections[0].querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-line]').length ?? 0;
            const frame = `${lines} lines at ${pane.scrollTop}`;
            if (seen.at(-1) !== frame) seen.push(frame);
          }
          if (seen.length < 5) requestAnimationFrame(record);
        };
        record();
      });
      await page.click('nav[aria-label="Changed files"] a[data-explain="server/git.ts"]');
      await page.until('server/git.ts alone, as a whole file', wholeFile, 'server/git.ts');
      await page.until('its first change in view', () => !!document.querySelector('section[data-file] diffs-container')?.shadowRoot?.querySelector('[data-line-type^="change-"]'));
      await page.until('the file as it showed', () => (window as unknown as { seen: string[] }).seen.length > 0);
      await holds('the file to stay as it showed', 300, async () => {
        const frames = await page.eval(() => (window as unknown as { seen: string[] }).seen);
        assert.equal(frames.length, 1, `the file changed after it showed, as its hunks alone or scrolled elsewhere: ${frames.join(' → ')}`);
        return true;
      });
      assert.equal(await page.eval(() => document.querySelector('nav[aria-label="Changed files"] > button')?.getAttribute('aria-pressed')), 'false');
      await shot('diff-whole-file');
      // The file opens at its first change and renders only the lines near the viewport, so look at both ends.
      await page.until('line 1 at the top of server/git.ts', edgeLine, 'top', 1);
      await page.until('line 181 at the bottom of server/git.ts', edgeLine, 'bottom', 181);
      assert.equal(await page.eval(() => document.querySelector('section[data-file] diffs-container')?.shadowRoot?.querySelector('pre')?.getAttribute('data-diff-type')), 'split');
      const [file] = await logged(mock, 'the whole-file request', (e) => e.path === '/api/diff/file');
      assert.equal(new URLSearchParams(file.query).get('path'), 'server/git.ts');
    },
  },
  {
    name: 'P0.5 a dropped connection (/mock/drop 3 s): the pill turns Reconnecting… with a warm dot, then Live with a green one',
    expectedErrors: [/WebSocket/, /ERR_CONNECTION/, /ERR_EMPTY_RESPONSE/],
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the live pill', () => document.querySelector('[data-link="live"]') !== null);
      assert.deepEqual(await page.eval(connection), { link: 'live', text: 'Live', warm: false, green: true });
      const start = Date.now();
      await mock.post('/mock/drop', { ms: 3000 });
      await page.until('the pill to turn reconnecting', () => document.querySelector('[data-link="reconnecting"]') !== null);
      const down = Date.now() - start;
      assert.deepEqual(await page.eval(connection), { link: 'reconnecting', text: 'Reconnecting…', warm: true, green: false });
      await shot('connection-dropped');
      await until('the pill to turn live again', () => page.eval(() => document.querySelector('[data-link="live"]') !== null), 10_000);
      const back = Date.now() - start;
      assert.ok(down < 1500, `reconnecting after ${down} ms`);
      assert.ok(back >= 3000, `live after ${back} ms, inside the drop`);
      assert.deepEqual(await page.eval(connection), { link: 'live', text: 'Live', warm: false, green: true });
      await shot('connection-back');
    },
  },
  {
    name: 'P0 narrow smoke: no sideways scroll on the board or in the sheet; New task and the way from the sheet to the card stay reachable',
    narrow: true,
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await page.until('New task in reach', reachable, 'button', 'New task');
      await shot('narrow-board');
      await page.goto(`${mock.url}/s/s-cart/details`);
      await page.until('the queue box', () => !!document.querySelector('#task-sheet [data-queued]'));
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      // The sheet slides up as it opens.
      await page.until('Open its card in reach', reachable, '#task-sheet [data-queued] button', 'Open its card');
      await shot('narrow-task');
    },
  },
  {
    name: 'P2.1 fonts: Bricolage Grotesque and Hanken Grotesk come with the app, and the page asks no host but 127.0.0.1',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      const fonts = await page.eval(async () => {
        await new Promise(requestAnimationFrame);
        await document.fonts.ready;
        return {
          display: document.fonts.check('600 38px "Bricolage Grotesque Variable"'),
          text: document.fonts.check('15px "Hanken Grotesk Variable"'),
          loaded: [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replaceAll('"', '')))].toSorted(),
        };
      });
      // check() is true for a family that nothing declares, too; only the loaded faces show the fonts arrived.
      assert.deepEqual(fonts, { display: true, text: true, loaded: ['Bricolage Grotesque Variable', 'Hanken Grotesk Variable'] });
      const files = page.requests.filter((url) => url.endsWith('.woff2')).map((url) => new URL(url).pathname.split('/').at(-1)!.replace(/-[\w-]{8}\.woff2$/, ''));
      assert.deepEqual(files.toSorted(), ['bricolage-grotesque-latin-opsz-normal', 'hanken-grotesk-latin-wght-normal']);
      const outside = page.requests.filter((url) => !/^(data|blob):/.test(url) && new URL(url).hostname !== '127.0.0.1');
      assert.deepEqual(outside, []);
    },
  },
  {
    name: "P2.2 the page background is C's ground: #110f0c in dark, #eeeae1 in light",
    async run({ themes, page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      await themes(async (scheme) => {
        const background = await page.eval(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
        assert.deepEqual(background, ['rgba(0, 0, 0, 0)', scheme === 'dark' ? 'rgb(17, 15, 12)' : 'rgb(238, 234, 225)']);
      });
      await shot('board');
    },
  },
  {
    name: 'P2.3 the Diff tab stays dark in the light theme too',
    async run({ themes, page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-cart/diff`);
      await page.until('the file tree', () => document.querySelectorAll('nav[aria-label="Changed files"] a').length === 12);
      await themes(async (scheme) => {
        const view = await page.eval(() => {
          const { backgroundColor, color } = getComputedStyle(document.querySelector('[data-theme="dark"]')!);
          return { backgroundColor, color };
        });
        assert.ok(luminance(view.backgroundColor) < 0.05, `the diff background ${view.backgroundColor} is not dark in ${scheme}`);
        assert.ok(luminance(view.color) > 0.5, `the diff text ${view.color} is not light in ${scheme}`);
      });
      await shot('diff');
    },
  },
  {
    name: 'P2.3b a folder in the diff\'s file tree collapses and expands with its chevron, leaving the diff and the folder filter alone',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-cart/diff`);
      await page.until('the file tree', () => document.querySelectorAll('nav[aria-label="Changed files"] a').length === 12);
      await page.click('nav[aria-label="Changed files"] button[aria-label="Collapse server/"]');
      await page.until('server/ collapsed to its row', () => document.querySelectorAll('nav[aria-label="Changed files"] a').length === 4);
      assert.equal(await page.eval(() => document.querySelector('nav[aria-label="Changed files"] button[aria-label="Expand server/"]')?.getAttribute('aria-expanded')), 'false');
      assert.equal(await page.eval(() => document.querySelectorAll('section[data-file]').length), 12);
      assert.equal(await page.eval(() => document.querySelector('nav[aria-label="Changed files"] > button')?.getAttribute('aria-pressed')), 'true');
      await shot('diff-folder-collapsed');
      await page.click('nav[aria-label="Changed files"] button[aria-label="Expand server/"]');
      await page.until('server/ expanded again', () => document.querySelectorAll('nav[aria-label="Changed files"] a').length === 12);

      await page.click('nav[aria-label="Changed files"] button[aria-label="Collapse server/"]');
      await page.until('server/ collapsed again', () => document.querySelectorAll('nav[aria-label="Changed files"] a').length === 4);
      // Under load the view can land back at the top after one scroll, inside the first file, which is in server/ too, so
      // nothing new comes into view; each try scrolls to the file again.
      await page.until('scrolling to a file in server/ opens it', () => {
        if (document.querySelectorAll('nav[aria-label="Changed files"] a').length === 12) {
          return document.querySelector('nav[aria-label="Changed files"] [aria-current]')?.getAttribute('data-explain')?.startsWith('server/') ?? false;
        }
        document.querySelector('section[data-file="server/mcpGuard.test.ts"]')!.scrollIntoView();
        return false;
      });
    },
  },
  {
    name: 'P2.linksOverview lists the links Claude gave and the claude.ai pages it made, newest first, described or by host and path; a click on one, or on a link in Claude\'s reply, opens it in the default browser through the server and the board stays put',
    async run({ page, mock, shot }) {
      await openSheetOf(page, mock, 's-cart');
      const links = await page.until('the links', () => {
        const items = [...document.querySelectorAll<HTMLAnchorElement>('#task-sheet [data-links] a')];
        return items.length && items.map((a) => [a.querySelector('strong')!.textContent, a.querySelector('span')!.textContent, a.dataset.explain]);
      });
      assert.deepEqual(links, [
        ['Cart merge – runtime test guide', 'claude.ai/artifact/9QsVfDkHMHJwhbwst8dnxB · 3m ago', 'Created the Claude Doc "Cart merge – runtime test guide"'],
        ['github.com/acme/storefront/pull/481', '4m ago', 'Draft PR: https://github.com/acme/storefront/pull/481'],
        ['Jira ticket CHK-412: carts never lose items', 'jira.example.com/browse/CHK-412 · 9m ago', 'The rule comes from [CHK-412](https://jira.example.com/browse/CHK-412).'],
      ]);
      await shot('links');

      const where = await page.eval(() => location.href);
      await page.click('#task-sheet [data-links] a[href="https://github.com/acme/storefront/pull/481"]');
      const [opened] = await logged(mock, 'the open', (e) => e.path === '/api/open');
      assert.deepEqual(opened.body, { url: 'https://github.com/acme/storefront/pull/481' });
      await page.click('#task-sheet a[href="https://jira.example.com/browse/CHK-412"]:not([data-links] a)');
      await until('the reply\'s link opened too', async () => (await mock.log()).filter((e) => e.path === '/api/open').length === 2);
      assert.equal(await page.eval(() => location.href), where, 'the board navigated');
      assert.equal(await page.eval(() => document.querySelectorAll('#task-sheet').length), 1);
    },
  },
  {
    name: 'P2.4 no console errors on the board, a decision, a menu, a reply with a table, the diff or an artifact',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      await openQueue(page, mock);
      await page.until('the options', () => document.querySelectorAll('[data-card] [data-option]').length === 3);
      await shot('task-ask');
      await page.key('ArrowRight');
      await page.until('the menu with its 2 questions', () => document.querySelectorAll('[data-card] section[role="group"]').length === 2);
      await shot('task-menu');
      await page.goto(`${mock.url}/s/s-reviews/details`);
      await page.until('the latest reply with its table', () => document.querySelector('section table') !== null);
      await shot('task-reply');
      await page.goto(`${mock.url}/s/s-cart/diff`);
      await page.until('every file rendered', () => [...document.querySelectorAll('section[data-file] diffs-container')].filter((d) => d.shadowRoot?.querySelector('pre')).length === 12);
      await page.goto(`${mock.url}/s/s-cart/artifacts`);
      await page.until('the artifact', () => document.querySelector('iframe') !== null);
      await shot('artifact');
      assert.deepEqual(page.errors, []);
    },
  },
];
