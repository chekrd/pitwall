import assert from 'node:assert/strict';
import { logged, openDecision, POSTED_MS, stateOf, tiles, toastsOf, type Check } from '../helpers.ts';
import type { Mock } from '../mock.ts';
import type { Page } from '../cdp.ts';
import { until } from '../cdp.ts';

const DIR = '.pitwall/artifacts/invoice-export';
const DESIGN = `${DIR}/04-design-discussion-invoice-export.md`;
const OUTLINE = `${DIR}/05-structure-outline-invoice-export.md`;
const PASSAGE = 'Streaming starts the download at once';
const BODY = '#task-sheet [data-document-body]';

const docUrl = (mock: Mock, path: string, id = 's-export') => `${mock.url}/s/${id}/documents/${encodeURIComponent(path)}`;
const headingIs = (want: string) => document.querySelector('#task-sheet [data-document-body] h1')?.textContent === want;

// The viewport points at the first and the last character of `text`, which lies in one text node of the document.
const endsOf = (text: string) => {
  const root = document.querySelector('#task-sheet [data-document-body] [data-markdown]')!;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const at = node.data.indexOf(text);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + text.length);
    (node.parentElement as HTMLElement).scrollIntoView({ block: 'center' });
    const rects = [...range.getClientRects()];
    const [first, last] = [rects[0], rects.at(-1)!];
    return { from: { x: first.left + 1, y: first.top + first.height / 2 }, to: { x: last.right - 1, y: last.top + last.height / 2 } };
  }
  return null;
};

async function select(page: Page, text: string) {
  const at = await page.until(`"${text}" in the document`, endsOf, text);
  await page.drag(at.from, at.to);
  assert.equal(await page.eval(() => getSelection()?.toString()), text);
}

// The passages marked, by comment.
const marked = () => {
  const byId: Record<string, string> = {};
  for (const m of document.querySelectorAll<HTMLElement>('#task-sheet [data-document-body] mark[data-comment]')) byId[m.dataset.comment!] = (byId[m.dataset.comment!] ?? '') + m.textContent;
  return byId;
};

const markCount = (n: number) => document.querySelectorAll('#task-sheet [data-document-body] mark[data-comment]:not([data-comment="new"])').length >= n;

const lit = () => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-document-body] mark[data-lit]')].map((m) => m.textContent).join('');

const counts = () => Object.fromEntries([...document.querySelectorAll<HTMLElement>('#task-sheet nav[aria-label="Documents"] button')]
  .flatMap((b) => {
    const count = b.querySelector('[data-comment-count]')?.textContent;
    return count ? [[b.dataset.document, count]] : [];
  }));

const inView = (selector: string) => {
  const el = document.querySelector(selector);
  const box = document.querySelector('#task-sheet [data-document-body]')!.getBoundingClientRect();
  const r = el?.getBoundingClientRect();
  return !!r && r.top >= box.top && r.bottom <= box.bottom;
};

const typedInto = async (mock: Mock, id: string) => ((await mock.get('/mock/typed')) as { session: string; text: string }[]).filter((t) => t.session === id).map((t) => t.text);

const comment = (id: string, path: string, heading: string | null, quote: string, text: string) =>
  ({ id, text, auto: false, armedAt: null, at: Date.now(), ref: { kind: 'document', path, heading, quote } });

const STALE = comment('p-export-batch', OUTLINE, 'Phase 2: GET /invoices/export streams a month', 'Stream 500 invoices at a time', 'Name the batch size, and why it is 500.');

const steps = () => [...document.querySelectorAll<HTMLButtonElement>('#task-sheet [data-next-steps] button')]
  .map((b) => `${b.dataset.variant === 'primary' ? '*' : ''}${b.textContent}${b.disabled ? ' (disabled)' : ''}`);

const fresh = () => document.querySelector<HTMLInputElement>('#task-sheet [data-next-steps] input[type="checkbox"]')?.checked ?? null;

const explainOf = (selector: string) => document.querySelector(selector)?.getAttribute('data-explain') ?? null;

export const comments: Check[] = [
  {
    name: 'CM.1 a passage selected in a document takes a comment: Comment by the selection opens a box, Enter keeps it under Later with the path, the heading above and the passage; it is marked in the document, counted in the list, shown in Later, and a click there opens the document at it, marked; one whose passage changed stays unmarked and opens at its heading; one on a document that is gone says so',
    scenario: 'workflow',
    async run({ page, mock, shot }) {
      await page.goto(docUrl(mock, DESIGN));
      await page.until('the design discussion', headingIs, 'Design Discussion: Invoice CSV export');
      assert.deepEqual(await page.eval(counts), { [OUTLINE]: '1 comment' }, 'the comment already kept on the outline');
      await select(page, PASSAGE);
      await page.click(`${BODY} [data-comment-button]`, 'Comment');
      await page.until('the comment box, focused', () => document.activeElement?.matches('#task-sheet [data-comment-note] textarea'));
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-comment-note] blockquote')?.textContent), PASSAGE);
      assert.deepEqual(await page.eval(marked), { new: PASSAGE }, 'the passage stays marked while the box has the focus');
      await page.type('Say what a failed stream leaves behind.');
      await shot('document-comment-box');
      await page.key('Enter');
      await page.until('the box to close', () => !document.querySelector('#task-sheet [data-comment-note]'));
      const [toast] = await until('the toast', () => page.eval(toastsOf, 'info'));
      assert.equal(toast.text, 'Kept for later: a comment on 04-design-discussion-invoice-export.md');
      const s = await stateOf(mock, 's-export');
      const kept = s.parked.find((p: { id: string }) => p.id !== STALE.id);
      assert.deepEqual([kept.text, kept.auto, kept.ref], ['Say what a failed stream leaves behind.', false, { kind: 'document', path: DESIGN, heading: 'Stream or build the file first?', quote: PASSAGE, version: 3 }], 'the version it was written on');
      await page.until('the passage marked', markCount, 1);
      assert.deepEqual(await page.eval(marked), { [kept.id]: PASSAGE });
      assert.equal(await page.eval(explainOf, `${BODY} mark[data-comment]`), 'Say what a failed stream leaves behind.', 'the comment on hover');
      await page.until('both counted', () => document.querySelectorAll('#task-sheet nav[aria-label="Documents"] [data-comment-count]').length === 2);
      assert.deepEqual(await page.eval(counts), { [DESIGN]: '1 comment', [OUTLINE]: '1 comment' });
      await shot('document-commented');

      await page.click('#task-sheet nav[aria-label="Documents"] button', 'Outline');
      await page.until('the outline', headingIs, 'Outline: Invoice CSV export');
      assert.deepEqual(await page.eval(marked), {}, 'a passage no longer in the document is not marked');
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-unsent-comments]')?.textContent), '1 comment not sent', 'by the next step, for the document of the phase under way');

      await page.key('1');
      await page.until('Later on Overview', () => document.querySelectorAll('#task-sheet [data-later] [data-document-ref]').length === 2);
      const later = await page.eval(() => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-later] li[data-parked]')]
        .map((li) => [li.querySelector('[data-document-ref] button')?.textContent, li.querySelector('[data-document-ref] blockquote')?.textContent, li.querySelector('p')?.textContent]));
      assert.deepEqual(later, [
        ['05-structure-outline-invoice-export.md · Phase 2: GET /invoices/export streams a month', 'Stream 500 invoices at a time', 'Name the batch size, and why it is 500.'],
        ['04-design-discussion-invoice-export.md · Stream or build the file first?', PASSAGE, 'Say what a failed stream leaves behind.'],
      ]);
      await shot('later-document-comments');
      await page.click(`#task-sheet [data-later] li[data-parked="${kept.id}"] [data-document-ref] button`);
      await page.until('the design discussion, opened from Later', (path: string) => location.pathname === path && document.querySelector('#task-sheet [data-document-body] h1')?.textContent === 'Design Discussion: Invoice CSV export',
        `/s/s-export/documents/${encodeURIComponent(DESIGN)}`);
      assert.equal(await page.until('the passage marked and lit', lit), PASSAGE);
      assert.ok(await page.eval(inView, `${BODY} mark[data-lit]`), 'scrolled to it');

      await page.key('1');
      await page.click(`#task-sheet [data-later] li[data-parked="${STALE.id}"] [data-document-ref] button`);
      await page.until('the outline, opened from Later', headingIs, 'Outline: Invoice CSV export');
      await page.until('its heading in view', () => {
        const h = [...document.querySelectorAll('#task-sheet [data-document-body] h2')].find((x) => x.textContent === 'Phase 2: GET /invoices/export streams a month');
        const box = document.querySelector('#task-sheet [data-document-body]')!.getBoundingClientRect();
        const r = h?.getBoundingClientRect();
        return !!r && r.top >= box.top - 1 && r.bottom <= box.bottom;
      });
      assert.deepEqual(await page.eval(marked), {});

      await mock.post('/mock/patch', { id: 's-export', patch: { parked: [...s.parked, comment('p-gone', `${DIR}/09-tdd-gone.md`, 'Gone', 'Nothing here', 'Was this dropped?')] } });
      await page.key('1');
      await page.click('#task-sheet [data-later] li[data-parked="p-gone"] [data-document-ref] button');
      await page.until('the toast that it is gone', () => [...document.querySelectorAll('[data-toast]')].some((t) => t.textContent?.includes("09-tdd-gone.md is gone from the task's folder; the comment stays under Later")));
      assert.ok((await stateOf(mock, 's-export')).parked.some((p: { id: string }) => p.id === 'p-gone'), 'it stays');
    },
  },
  {
    name: 'CM.2 Send 2 comments on a document posts one /rpi:rpi update command naming it on its own first line, then each comment with its heading and passage quoted, held with Undo; the comments leave Later and the marks go; while Claude works it is disabled and says why',
    scenario: 'workflow',
    clock: 'fast',
    async run({ page, mock, wait }) {
      const units = 'Amounts are written in major units with two decimals';
      const first = comment('c-stream', DESIGN, 'Stream or build the file first?', PASSAGE, 'Say what a failed stream leaves behind.');
      const second = comment('c-units', DESIGN, 'Resolved Design Questions', units, 'Keep minor units in the file too.');
      await mock.post('/mock/patch', { id: 's-export', patch: { parked: [STALE, first, second], status: 'working', activity: { step: 'Bash: pnpm test', since: Date.now() } } });
      await page.goto(docUrl(mock, DESIGN));
      await page.until('the design discussion', headingIs, 'Design Discussion: Invoice CSV export');
      await page.until('both marked', () => new Set([...document.querySelectorAll<HTMLElement>('#task-sheet [data-document-body] mark[data-comment]')].map((m) => m.dataset.comment)).size === 2);
      assert.deepEqual(await page.eval(marked), { 'c-stream': PASSAGE, 'c-units': units });
      const button = '#task-sheet [data-send-comments]';
      assert.deepEqual(await page.until('the send button', (b: string) => {
        const el = document.querySelector<HTMLButtonElement>(b);
        return el && [el.textContent, el.disabled, el.dataset.explain];
      }, button), ['Send 2 comments', true, 'Claude is at work; this can go once its turn has ended.']);
      assert.deepEqual(await page.eval(steps), ['*Implement the next phase (disabled)']);

      await mock.post('/mock/patch', { id: 's-export', patch: { status: 'idle', activity: null } });
      await page.until('the button enabled', (b: string) => document.querySelector<HTMLButtonElement>(b)?.disabled === false, button);
      await page.click(button);
      const [held] = await until('the held toast', () => page.eval(toastsOf, 'undo'));
      assert.match(held.text, new RegExp(`^Sending: /rpi:rpi update ${DESIGN.replaceAll('.', '\\.')}`));
      const message = [
        `/rpi:rpi update ${DESIGN}`,
        `Under “Stream or build the file first?”:\n> ${PASSAGE}\n\nSay what a failed stream leaves behind.`,
        `Under “Resolved Design Questions”:\n> ${units}\n\nKeep minor units in the file too.`,
      ].join('\n\n');
      const [post] = await logged(mock, 'the comments sent', (e) => e.action === 'answer' && e.sessionId === 's-export', POSTED_MS);
      assert.deepEqual(post.body, { key: null, text: message, drafts: ['c-stream', 'c-units'] });
      assert.deepEqual(await until('typed', async () => (await typedInto(mock, 's-export')).length && typedInto(mock, 's-export')), [message], 'typed as it is, one message');
      await page.until('the button gone', (b: string) => !document.querySelector(b), button);
      assert.deepEqual(await page.eval(marked), {});
      assert.deepEqual((await stateOf(mock, 's-export')).parked.map((p: { id: string }) => p.id), [STALE.id], 'only the comment on the outline stays');
      await wait(500);
      assert.deepEqual(await page.eval(counts), { [OUTLINE]: '1 comment' });
    },
  },
  {
    name: "CM.3 by the phase strip the Documents tab offers rpi's next steps for the flow: with Fresh conversation, on by default and remembered, /clear goes first and the command once Claude has started the new conversation; without it the command alone; a /clear never taken sends nothing more and says so; while Claude works they are disabled",
    scenario: 'workflow',
    clock: 'fast',
    expectedErrors: [/status of 400/],
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-export/documents`);
      await page.until('the steps', () => !!document.querySelector('#task-sheet [data-next-steps] button'));
      assert.deepEqual(await page.eval(steps), ['*Implement the next phase']);
      assert.equal(await page.eval(fresh), true, 'Fresh conversation is on by default');
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-unsent-comments]')?.textContent), '1 comment not sent');
      assert.match(await page.eval(explainOf, '#task-sheet [data-next-steps] button') ?? '', /“\/clear”, then, once Claude has started the new conversation, “\/rpi:rpi implement \.pitwall\/artifacts\/invoice-export”/);
      await shot('documents-next-steps');
      const before = (await stateOf(mock, 's-export')).conversation;
      await page.click('#task-sheet [data-next-steps] button', 'Implement the next phase');
      const [held] = await until('the held toast', () => page.eval(toastsOf, 'undo'));
      assert.equal(held.text.split('\n')[0], `Sending: /clear, then /rpi:rpi implement ${DIR}`);
      const [post] = await logged(mock, 'the step sent', (e) => e.action === 'answer' && e.sessionId === 's-export', POSTED_MS);
      assert.deepEqual(post.body, { key: null, text: `/rpi:rpi implement ${DIR}`, fresh: true });
      assert.deepEqual(await typedInto(mock, 's-export'), ['/clear', `/rpi:rpi implement ${DIR}`], 'in order, the command after the clear was taken');
      assert.notEqual((await stateOf(mock, 's-export')).conversation, before, 'a new conversation');

      await page.click('#task-sheet [data-next-steps] label', 'Fresh conversation');
      assert.equal(await page.eval(fresh), false);
      await page.goto(`${mock.url}/s/s-export/documents`);
      await page.until('the steps again', () => !!document.querySelector('#task-sheet [data-next-steps] button'));
      assert.equal(await page.eval(fresh), false, 'remembered');
      await page.click('#task-sheet [data-next-steps] button', 'Implement the next phase');
      await logged(mock, 'the step sent alone', (e) => e.action === 'answer' && e.sessionId === 's-export' && !e.body.fresh, POSTED_MS);
      assert.deepEqual(await typedInto(mock, 's-export'), ['/clear', `/rpi:rpi implement ${DIR}`, `/rpi:rpi implement ${DIR}`]);

      await page.goto(`${mock.url}/s/s-search-page/documents`);
      await page.until('the steps of the search page', () => !!document.querySelector('#task-sheet [data-next-steps] button'));
      assert.deepEqual(await page.eval(steps), ['*PRD (disabled)', 'Outline (disabled)', 'Implement (disabled)'], 'Claude is at work');
      await mock.post('/mock/patch', { id: 's-search-page', patch: { status: 'idle', activity: null } });
      await page.until('enabled', () => !document.querySelector('#task-sheet [data-next-steps] button:disabled'));
      await page.click('#task-sheet [data-next-steps] button', 'PRD');
      await logged(mock, 'the PRD step', (e) => e.action === 'answer' && e.sessionId === 's-search-page', POSTED_MS);
      assert.deepEqual(await typedInto(mock, 's-search-page'), ['/rpi:rpi make a PRD .pitwall/artifacts/search-page; flow: prd']);

      await mock.post('/mock/clear-ignored', { on: true });
      await page.click('#task-sheet [data-next-steps] label', 'Fresh conversation');
      assert.equal(await page.eval(fresh), true);
      await page.click('#task-sheet [data-next-steps] button', 'Outline');
      const [error] = await until('the refusal', () => page.eval(toastsOf, 'error'), 15_000);
      assert.equal(error.text, 'Not sent to Docs search page: Claude did not start a new conversation after /clear, so “/rpi:rpi make an outline .pitwall/artifacts/search-page; flow: prd” was not sent\nShow');
      assert.deepEqual(await typedInto(mock, 's-search-page'), ['/rpi:rpi make a PRD .pitwall/artifacts/search-page; flow: prd', '/clear'], 'nothing after the /clear');
    },
  },
  {
    name: "CM.4 a /rpi typed in a reply box is a command though Claude lists the skill only as rpi:rpi: it goes in as it is and the open decision stays open",
    clock: 'fast',
    async run({ page, mock }) {
      await openDecision(page, mock);
      await page.key('w');
      await page.until('the reply box', () => document.activeElement?.matches('[data-decision] textarea'));
      await page.type('/rpi research .pitwall/artifacts/guest-cart');
      await page.key('Enter');
      const [post] = await logged(mock, 'the command', (e) => e.action === 'answer' && e.sessionId === 's-cart', POSTED_MS);
      assert.deepEqual(post.body, { key: 'q:toolu_01Cart', text: '/rpi research .pitwall/artifacts/guest-cart' });
      assert.deepEqual(await typedInto(mock, 's-cart'), ['/rpi research .pitwall/artifacts/guest-cart']);
      assert.ok((await stateOf(mock, 's-cart')).question, 'the decision stays open');
    },
  },
  {
    name: 'CM.5 a Wall tile counts its task\'s drafts under Later quietly, Later 1 then Later 2 as another is kept; a task with none shows no count',
    scenario: 'workflow',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      const later = () => Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-tile]')]
        .flatMap((t) => {
          const c = t.querySelector('[data-later-count]')?.textContent;
          return c ? [[t.dataset.session, c]] : [];
        }));
      assert.deepEqual(await page.until('the count', () => document.querySelector('[data-later-count]') && true), true);
      assert.deepEqual(await page.eval(later), { 's-export': 'Later 1' });
      await mock.post('/mock/patch', { id: 's-export', patch: { parked: [STALE, { id: 'k2', text: 'Also the credit notes.', auto: false, armedAt: null, at: Date.now() }] } });
      await page.until('Later 2', () => document.querySelector('[data-tile][data-session="s-export"] [data-later-count]')?.textContent === 'Later 2');
      await shot('wall-later-count');
    },
  },
];
