import assert from 'node:assert/strict';
import { decisionKey } from '../../../server/decision.ts';
import { sleep, until } from '../cdp.ts';
import { card, listen, loads, logged, named, navigation, openNewTask, openQueue, POSTED_MS, ready, received, tiles, withOwnBuild, type Check, type Probe } from '../helpers.ts';

export const builds: Check[] = [
  {
    name: 'P1a.mock-contract two answers at once to one end-of-turn decision: one 204 and one 400 answered (two 204s with --legacy), both in /mock/log',
    expectedErrors: [/status of 400/],
    async run({ page, mock }) {
      const { legacy } = await mock.get('/mock');
      const group = async () => (await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === 's-group');
      const { summary } = await group();
      const body = { key: `s:${summary.basis}`, choice: summary.decision.options[0].label };
      // Not the board: today's UI throws when the double send of --legacy reorders it twice at once.
      await page.goto(`${mock.url}/mock`);
      const replies = await page.eval(async (body) => {
        const post = async () => {
          const res = await fetch('/api/sessions/s-group/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          return { status: res.status, body: res.status === 204 ? null : await res.json() };
        };
        return Promise.all([post(), post()]);
      }, body);
      const second = legacy ? { status: 204, body: null } : { status: 400, body: { error: 'you already answered this', code: 'answered' } };
      assert.deepEqual(replies.toSorted((a, b) => a.status - b.status), [{ status: 204, body: null }, second]);
      const entries = await logged(mock, 'both answers', (e) => e.action === 'answer' && e.sessionId === 's-group');
      assert.deepEqual(entries.toSorted((a, b) => a.status! - b.status!).map((e) => [e.status, e.code, e.body]), [
        [204, null, body],
        [second.status, second.body?.code ?? null, body],
      ]);
      const after = await group();
      if (legacy) assert.equal('answered' in after, false);
      else assert.deepEqual([after.answered.key, after.answered.text], [body.key, body.choice]);
      await until('s-group to start on the answer, with no step yet', async () => {
        const s = await group();
        return s.status === 'working' && s.activity.step === (legacy ? 'Thinking' : null);
      });
    },
  },
  {
    name: 'P1a.compat-accept the card accepts the second opinion on a question and on a menu; the snapshot names what was sent',
    clock: 'fast',
    async run({ page, mock, shot }) {
      const { legacy } = await mock.get('/mock');
      const sessionOf = async (id: string) => (await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === id);
      for (const [id, key, text, action] of [
        ['s-cart', 'q:toolu_01Cart', 'Merge both carts. Cap each line at available stock and show a toast listing anything trimmed.', 'accept-advice'],
        ['s-hooks', 'm:toolu_01Hooks', 'Backoff: Exponential, 5 tries · Give up: Email the account owner, Disable the endpoint', 'answer-menu'],
      ]) {
        await page.goto(`${mock.url}/`);
        await page.click(`[data-segment][data-session="${id}"]`);
        await ready(page, id);
        assert.equal((await page.eval(card))!.primary, 'Accept suggestion');
        // The segment keeps focus after the click, and ⏎ on it would press it again.
        await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.key('Enter');
        const [accepted] = await logged(mock, `the accepted second opinion of ${id}`, (e) => e.action === action && e.sessionId === id, POSTED_MS);
        assert.deepEqual([accepted.status, accepted.body.key ?? `m:${accepted.body.toolUseId}`], [204, key]);
        const s = await sessionOf(id);
        if (legacy) assert.equal('answered' in s, false);
        else assert.deepEqual([s.answered.key, s.answered.text], [key, text]);
        await until(`${id} to start working`, async () => (await sessionOf(id)).status === 'working');
        await shot(`accepted-${id}`);
      }
    },
  },
  {
    name: 'P1a.compat-dismiss the card dismisses a question: it closes, the tile leaves Decide, and nothing counts as answered',
    clock: 'fast',
    async run({ page, mock, shot }) {
      const { legacy } = await mock.get('/mock');
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.click('[data-card] footer button', 'Dismiss');
      const [dismissed] = await logged(mock, 'the dismissal', (e) => e.action === 'dismiss', POSTED_MS);
      assert.deepEqual([dismissed.sessionId, dismissed.status, dismissed.body.key], ['s-cart', 204, 'q:toolu_01Cart']);
      const s = (await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === 's-cart');
      assert.deepEqual([s.question, s.dismissedAsk, s.status, s.answered], [null, 'toolu_01Cart', 'idle', legacy ? undefined : null]);
      await page.goto(`${mock.url}/wall`);
      await page.until('the s-cart tile to leave Decide', () =>
        document.querySelector('[data-tile][data-session="s-cart"]')?.getAttribute('data-attention') === 'idle');
      await shot('dismissed');
    },
  },
  {
    name: 'P1a.mock-reset an answer still typing when the scenario loads again fails and leaves the fresh scenario alone; so does a note waiting behind an answer to an end-of-turn decision',
    async run({ mock }) {
      const { legacy } = await mock.get('/mock');
      const sessionsNow = async () => new Map<string, any>((await mock.get('/api/state')).sessions.map((s: { id: string }) => [s.id, s]));
      const answer = (id: string, body: object) => fetch(`${mock.url}/api/sessions/${id}/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const { summary } = (await sessionsNow()).get('s-group');
      const sends = [
        answer('s-cart', { key: 'q:toolu_01Cart', choice: 'Keep the account cart' }),
        answer('s-group', { key: `s:${summary.basis}`, choice: summary.decision.options[0].label }),
      ];
      if (legacy) await Promise.all(sends);
      else await until('both answers to be claimed and typing', async () => {
        const now = await sessionsNow();
        return now.get('s-cart').answered && now.get('s-group').answered;
      });
      // A message meets an end-of-turn decision and claims it, so one still waiting its turn must not reach the fresh s-group.
      sends.push(answer('s-group', { key: null, text: 'Also bump the version' }));
      if (legacy) await sends[2];
      else await until('the note to wait its turn', async () => (await mock.log()).some((e) => e.sessionId === 's-group' && e.body.key === null && e.status === null));
      await mock.post('/mock/scenario/queue');
      const replies = await Promise.all(sends.map(async (sent) => {
        const reply = await sent;
        return [reply.status, reply.status === 204 ? null : (await reply.json()).error];
      }));
      assert.deepEqual(replies, Array(3).fill(legacy ? [204, null] : [400, 'the mock loaded another scenario meanwhile']));
      await sleep(1000);
      const now = await sessionsNow();
      const [cart, group] = [now.get('s-cart'), now.get('s-group')];
      assert.deepEqual([cart.question?.toolUseId, cart.answered ?? null, cart.status], ['toolu_01Cart', null, 'idle']);
      assert.deepEqual([decisionKey(group), group.answered ?? null, group.status], [`s:${summary.basis}`, null, 'idle']);
    },
  },
  {
    name: 'P1b.ui-entry a socket gets uiEntry, the build\'s entry script, on open and in every snapshot pushed after (on --legacy only on open); the open page keeps itself when the entry is its own',
    async run({ page, mock }) {
      const { legacy } = await mock.get('/mock');
      await page.goto(`${mock.url}/`);
      await page.until('the first snapshot', () => document.querySelector('[data-link]')?.getAttribute('data-link') === 'live');
      const entry = await page.eval(listen);
      assert.match(entry ?? '', /^\/assets\/index-[\w-]+\.js$/);
      assert.deepEqual(await page.until('the snapshot on open', received, null), { carries: true, uiEntry: entry });
      const title = 'Lazy-load product reviews, patched';
      await mock.post('/mock/patch', { id: 's-reviews', patch: { title } });
      assert.deepEqual(await page.until('the snapshot pushed after the patch', received, title), legacy ? { carries: false, uiEntry: null } : { carries: true, uiEntry: entry });
      // The page's own socket got the same push; a reload it caused would have replaced the document by now.
      await sleep(1000);
      assert.deepEqual(await page.eval(navigation), { marker: true, type: 'navigate', entry });
    },
  },
  {
    name: 'P1b.ui-entry-build a build written into the folder the server serves reaches an open page: it reloads into the new entry once, and stays',
    async run({ page }) {
      await withOwnBuild(page, async (own, build) => {
        const url = `${own.url}/`;
        await page.goto(url);
        await page.until('the first snapshot', () => document.querySelector('[data-link]')?.getAttribute('data-link') === 'live');
        await page.eval(() => void ((window as unknown as Probe).e2eMarker = true));
        const next = build();
        // Read twice 2 s apart before it counts, so the reload comes 2 to 4 s after the build.
        const reloaded = await until('the page to reload into the new build', () => page.eval(navigation).then((n) => n.entry === next && n, () => null), 15_000);
        assert.deepEqual(reloaded, { marker: null, type: 'reload', entry: next });
        await page.until('the first snapshot', () => document.querySelector('[data-link]')?.getAttribute('data-link') === 'live');
        await page.eval(() => void ((window as unknown as Probe).e2eMarker = true));
        await own.post('/mock/patch', { id: 's-reviews', patch: { title: 'Lazy-load product reviews, patched' } });
        await sleep(3000);
        assert.deepEqual([await page.eval(navigation), loads(page, url)], [{ marker: true, type: 'reload', entry: next }, 2]);
      });
    },
  },
  {
    name: 'P1b.ui-entry-early a page loaded from a new build before the server has taken it loads once and stays: the snapshot on open and one pushed meanwhile name no entry, and the one when the build is taken names its entry',
    async run({ page }) {
      await withOwnBuild(page, async (own, build) => {
        const url = `${own.url}/`;
        const next = build();
        await page.goto(url);
        // Time for the reload a snapshot on open naming the older entry would cause.
        await sleep(500);
        assert.equal(loads(page, url), 1, 'the page reloaded');
        await page.until('the first snapshot', () => document.querySelector('[data-link]')?.getAttribute('data-link') === 'live');
        assert.equal(await page.eval(listen), next);
        assert.deepEqual(await page.until('the snapshot on open', received, null), { carries: true, uiEntry: null });
        const title = 'Lazy-load product reviews, patched';
        await own.post('/mock/patch', { id: 's-reviews', patch: { title } });
        await sleep(300);
        assert.equal(loads(page, url), 1, 'the snapshot pushed after the patch reloaded the page');
        // The build is taken two polls 2 s apart after it lands, so this push comes before.
        assert.deepEqual(await page.until('the snapshot pushed after the patch', received, title), { carries: true, uiEntry: null });
        await page.until('the snapshot pushed when the build is taken', named, next, title);
        // The page's own socket got the same pushes; a reload they caused would have replaced the document by now.
        await sleep(1000);
        assert.deepEqual([await page.eval(navigation), loads(page, url)], [{ marker: true, type: 'navigate', entry: next }, 1]);
      });
    },
  },
  {
    name: 'P3.reload-gate a new build reloads the board when nothing is focused; New task holds it until it closes, on the Wall as over the queue, even with nothing focused in it; the page\'s own entry never reloads it, nor a build it already reloaded for',
    async run({ page, mock, shot }) {
      const mark = () => page.eval(() => void ((window as unknown as { probe?: number }).probe = 1));
      const marked = () => page.eval(() => (window as unknown as { probe?: number }).probe === 1);
      const newBuild = (n: number) => mock.post('/mock/ui-entry', { src: `/assets/index-next${n}.js` });
      // The old document goes away under a call, so a failed call means "not yet".
      const reloaded = (what: string) => until(`the page to reload ${what}`, async () => {
        try {
          return await page.eval(() => (window as unknown as { probe?: number }).probe === undefined && document.readyState === 'complete');
        } catch {
          return false;
        }
      });

      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      await mark();
      await newBuild(1);
      await reloaded('with nothing focused');
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);

      await mark();
      const own = await page.eval(() => document.querySelector('script[type="module"][src]')!.getAttribute('src')!);
      await mock.post('/mock/ui-entry', { src: own });
      await mock.post('/mock/ui-entry', { src: `${mock.url}${own}` });
      await sleep(3000);
      assert.equal(await marked(), true, 'its own entry reloaded the page');

      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await page.type('Ship it after lunch');
      await mark();
      await newBuild(2);
      await sleep(3000);
      const typing = await page.eval(() => [
        (window as unknown as { probe?: number }).probe, document.activeElement?.tagName, document.querySelector<HTMLTextAreaElement>('dialog#new-task textarea')?.value,
      ]);
      assert.deepEqual(typing, [1, 'TEXTAREA', 'Ship it after lunch']);
      await shot('draft-holds-reload');
      await page.key('Escape');
      await reloaded('once New task closed on the Wall');

      await page.goto(`${mock.url}/`);
      await page.click('button', 'New task');
      await page.until('the New task dialog', () => !!document.querySelector<HTMLDialogElement>('dialog#new-task')?.open);
      const blurred = await page.eval(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        return document.activeElement === document.body;
      });
      assert.equal(blurred, true, 'only the open dialog holds the reload');
      await mark();
      await newBuild(3);
      await sleep(3000);
      assert.equal(await marked(), true, 'reloaded under the New task dialog');
      await shot('dialog-holds-reload');
      await page.key('Escape');
      await reloaded('once the dialog closed');

      // The mock serves the same entry whatever it announces, so each reload above came back to it, as when the
      // server reads some other script as the entry.
      await page.until('the card', () => !!document.querySelector('[data-card]'));
      await mark();
      await newBuild(3);
      await sleep(3000);
      assert.equal(await marked(), true, 'reloaded again for a build that brought it back to its own entry');
    },
  },
  {
    name: 'P3.reload-offline a new build waits for the server: New task closing while the server cannot be reached does not reload the board, and it reloads once the server is back and names that build',
    expectedErrors: [/WebSocket/, /ERR_CONNECTION/, /ERR_EMPTY_RESPONSE/, /ERR_SOCKET_NOT_CONNECTED/],
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      await page.type('Ship it after lunch');
      await page.eval(() => void ((window as unknown as { probe?: number }).probe = 1));
      await mock.post('/mock/ui-entry', { src: '/assets/index-offline.js' });
      await mock.post('/mock/drop', { ms: 4000 });
      try {
        await page.until('the server to drop the page', () => fetch('/').then(() => false, () => true));
        await page.key('Escape');
        await sleep(1500);
        const kept = await page.eval(() => [
          (window as unknown as { probe?: number }).probe, !document.querySelector('dialog#new-task[open]'), document.querySelector<HTMLTextAreaElement>('dialog#new-task textarea')?.value,
        ]);
        assert.deepEqual(kept, [1, true, 'Ship it after lunch'], 'reloaded while the server could not be reached');
        await shot('offline-holds-reload');
      } finally {
        // The next check's reset cannot reach the mock until the drop is over.
        await until('the drop to end', () => mock.get('/mock').then(() => true, () => false), 10_000);
      }
      // A server back with the new build names it to the page that reconnects; the mock names the build it serves, so
      // the check names the new one again once the page is live.
      const back = await until('the page to reconnect', async () => {
        try {
          return await page.eval(() => ((window as unknown as { probe?: number }).probe === undefined ? 'reloaded' : document.querySelector('[data-link="live"]') ? 'live' : null));
        } catch {
          return null;
        }
      }, 10_000);
      if (back === 'live') await mock.post('/mock/ui-entry', { src: '/assets/index-offline.js' });
      await until('the page to reload once the server is back', async () => {
        try {
          return await page.eval(() => (window as unknown as { probe?: number }).probe === undefined && document.readyState === 'complete');
        } catch {
          return false;
        }
      }, 10_000);
      await page.until('the Wall', () => document.querySelectorAll('[data-tile]').length > 0);
    },
  },
];
