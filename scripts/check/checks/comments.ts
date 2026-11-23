import assert from 'node:assert/strict';
import { logged, openDecision, POSTED_MS, stateOf, tiles, toastsOf, type Check } from '../helpers.ts';
import type { Mock } from '../mock.ts';
import type { Page } from '../cdp.ts';
import { until } from '../cdp.ts';
import { BOARD_HANDOFF } from '../../../server/rpi.ts';

const DIR = '.pitwall/artifacts/invoice-export';
const REQUEST = `${DIR}/01-request-invoice-export.md`;
const QUESTIONS = `${DIR}/02-research-questions-invoice-export.md`;
const RESEARCH = `${DIR}/03-research-invoice-export.md`;
const DESIGN = `${DIR}/04-design-discussion-invoice-export.md`;
const OUTLINE = `${DIR}/05-structure-outline-invoice-export.md`;
const PASSAGE = 'Streaming starts the download at once';
const BODY = '#task-sheet [data-document-body]';
const PANEL = '#task-sheet [data-comments-panel]';

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

// A drag over `text` once it stays put. The document may still be drawn again as the board's state arrives, moving the
// text under the drag, so a drag that selected something else is tried again, as click() tries a click again.
export async function select(page: Page, text: string) {
  let selected = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    let last = '';
    const at = await until(`"${text}" in the document, staying put`, async () => {
      const ends = await page.eval(endsOf, text);
      const now = JSON.stringify(ends);
      const still = !!ends && now === last;
      last = now;
      return still && ends;
    });
    await page.drag(at.from, at.to);
    selected = await page.eval(() => getSelection()?.toString() ?? '');
    if (selected === text) return;
  }
  assert.equal(selected, text);
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

// The open comments in the panel, each as where it is about and its text.
const panel = () => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-comments-panel] > ul > li[data-doc-comment]')]
  .map((li) => [li.querySelector('[data-whole-label]') ? 'Whole document' : li.querySelector('[data-comment-passage] blockquote')?.textContent, li.querySelector('p')?.textContent]);

const inView = (selector: string) => {
  const el = document.querySelector(selector);
  const box = document.querySelector('#task-sheet [data-document-body]')!.getBoundingClientRect();
  const r = el?.getBoundingClientRect();
  return !!r && r.top >= box.top && r.bottom <= box.bottom;
};

const typedInto = async (mock: Mock, id: string) => ((await mock.get('/mock/typed')) as { session: string; text: string }[]).filter((t) => t.session === id).map((t) => t.text);

const docComment = (id: string, path: string, heading: string | null, quote: string | null, text: string, version: number | null = null) =>
  ({ id, path, version, heading, quote, text, at: Date.now(), sentAt: null });

const STALE = docComment('p-export-batch', OUTLINE, 'Phase 2: GET /invoices/export streams a month', 'Stream 500 invoices at a time', 'Name the batch size, and why it is 500.');

const steps = () => [...document.querySelectorAll<HTMLButtonElement>('#task-sheet [data-next-steps] button')]
  .map((b) => `${b.dataset.variant === 'primary' ? '*' : ''}${b.textContent}${b.disabled ? ' (disabled)' : ''}`);

const explainOf = (selector: string) => document.querySelector(selector)?.getAttribute('data-explain') ?? null;

type Comment = { id: string; path: string; version: number | null; heading: string | null; quote: string | null; text: string; at: number; sentAt: number | null; archivedAt?: number | null };
const commentsOf = async (mock: Mock): Promise<Comment[]> => (await stateOf(mock, 's-export')).review.comments;

const outdatedOf = async (mock: Mock): Promise<Record<string, { because: string; version: number | null }>> => (await stateOf(mock, 's-export')).review.outdated;

const stripOutdated = () => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-phase-strip] li[data-outdated]')].map((li) => li.dataset.phase);

export const comments: Check[] = [
  {
    name: 'CM.1 a passage selected in a document takes a comment in the panel beside it: Comment by the selection opens a box whose only action adds it, Enter adds it with the path, version, heading and passage; it is marked, counted in the list and listed in the panel, where a click lights it in the document; it can be edited, and archived with Undo, then restored from Archived as it was; one whose passage changed stays unmarked and its click goes to its heading; none of it shows under Later or by the next steps',
    scenario: 'workflow',
    async run({ page, mock, shot }) {
      await page.goto(docUrl(mock, DESIGN));
      await page.until('the design discussion', headingIs, 'Design Discussion: Invoice CSV export');
      assert.deepEqual(await page.eval(counts), { [OUTLINE]: '1 comment' }, 'the comment already written on the outline');
      assert.deepEqual(await page.eval(panel), [], 'none on this document');
      await select(page, PASSAGE);
      await page.click(`${BODY} [data-comment-button]`, 'Comment');
      await page.until('the comment box, focused', () => document.activeElement?.matches('#task-sheet [data-comment-note] textarea'));
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-comment-note] blockquote')?.textContent), PASSAGE);
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll('#task-sheet [data-comment-note] button')].map((b) => b.textContent)), ['Cancel', 'Add comment'], 'no Later wording');
      assert.deepEqual(await page.eval(marked), { new: PASSAGE }, 'the passage stays marked while the box has the focus');
      await page.type('Say what a failed stream leaves behind.');
      await shot('document-comment-box');
      await page.key('Enter');
      await page.until('the box to close', () => !document.querySelector('#task-sheet [data-comment-note]'));
      const kept = await until('the comment kept', async () => (await commentsOf(mock)).find((c) => c.id !== STALE.id));
      assert.deepEqual({ ...kept, id: '', at: 0 }, { id: '', path: DESIGN, version: 3, heading: 'Stream or build the file first?', quote: PASSAGE, text: 'Say what a failed stream leaves behind.', at: 0, sentAt: null, archivedAt: null });
      await page.until('the passage marked', markCount, 1);
      assert.deepEqual(await page.eval(marked), { [kept.id]: PASSAGE });
      assert.equal(await page.eval(explainOf, `${BODY} mark[data-comment]`), 'Say what a failed stream leaves behind.', 'the comment on hover');
      await page.until('in the panel', () => document.querySelectorAll('#task-sheet [data-comments-panel] > ul > li[data-doc-comment]').length === 1);
      assert.deepEqual(await page.eval(panel), [[PASSAGE, 'Say what a failed stream leaves behind.']]);
      assert.deepEqual(await page.eval(counts), { [DESIGN]: '1 comment', [OUTLINE]: '1 comment' });
      await shot('document-commented');

      await page.eval(() => document.querySelector('#task-sheet [data-document-body]')!.scrollTo(0, 0));
      await page.click(`${PANEL} li[data-doc-comment="${kept.id}"] [data-comment-passage]`);
      assert.equal(await page.until('the passage lit', lit), PASSAGE);
      assert.ok(await page.eval(inView, `${BODY} mark[data-lit]`), 'scrolled to it');

      await page.click(`${PANEL} li[data-doc-comment="${kept.id}"] button`, 'Edit');
      await page.until('the edit field, focused', () => document.activeElement?.matches('#task-sheet [data-comments-panel] li textarea'));
      await page.eval(() => (document.activeElement as HTMLTextAreaElement).select());
      await page.type('Say what a failed stream leaves on disk.');
      await page.key('Enter');
      await until('the text edited', async () => (await commentsOf(mock)).find((c) => c.id === kept.id)?.text === 'Say what a failed stream leaves on disk.');
      const [edit] = await logged(mock, 'the edit', (e) => e.action === 'edit-comment' && e.sessionId === 's-export');
      assert.deepEqual(edit.body, { comment: kept.id, text: 'Say what a failed stream leaves on disk.' });
      await page.until('the edit in the panel', (id: string) => document.querySelector(`#task-sheet [data-comments-panel] li[data-doc-comment="${id}"] p`)?.textContent === 'Say what a failed stream leaves on disk.', kept.id);

      const openShown = () => document.querySelectorAll('#task-sheet [data-comments-panel] > ul > li[data-doc-comment]').length;
      await page.click(`${PANEL} li[data-doc-comment="${kept.id}"] button`, 'Archive');
      await page.until('gone from the panel', () => document.querySelectorAll('#task-sheet [data-comments-panel] > ul > li[data-doc-comment]').length === 0);
      await page.until('the mark gone', () => !document.querySelector('#task-sheet [data-document-body] mark[data-comment]'));
      const archivedOne = await until('archived, kept', async () => (await commentsOf(mock)).find((c) => c.id === kept.id && typeof c.archivedAt === 'number'));
      assert.deepEqual([archivedOne.text, archivedOne.sentAt], ['Say what a failed stream leaves on disk.', null]);
      const [toast] = await until('the toast', () => page.eval(toastsOf, 'info'));
      assert.equal(toast.text, 'Archived the comment “Say what a failed stream leaves on disk.”\nUndo');
      await page.click('[data-toast] button', 'Undo');
      const back = await until('the comment back', async () => (await commentsOf(mock)).find((c) => c.id === kept.id && c.archivedAt === null));
      assert.deepEqual([back.path, back.version, back.heading, back.quote, back.at, back.sentAt], [DESIGN, 3, kept.heading, PASSAGE, kept.at, null], 'as it was');
      await page.until('marked again', markCount, 1);

      await page.click(`${PANEL} li[data-doc-comment="${kept.id}"] button`, 'Archive');
      await page.until('under Archived', () => document.querySelector('#task-sheet [data-archived-comments] summary')?.textContent === 'Archived · 1');
      assert.equal(await page.eval(openShown), 0);
      await page.click('#task-sheet [data-archived-comments] summary');
      await page.until('the archived one shown', (id: string) => {
        const li = document.querySelector<HTMLElement>(`#task-sheet [data-archived-comments] li[data-doc-comment="${id}"]`);
        return !!li?.checkVisibility() && li.querySelector('p')?.textContent === 'Say what a failed stream leaves on disk.' && li.textContent?.includes('Not sent');
      }, kept.id);
      await page.click(`#task-sheet [data-archived-comments] li[data-doc-comment="${kept.id}"] button`, 'Restore');
      await page.until('open again', () => document.querySelectorAll('#task-sheet [data-comments-panel] > ul > li[data-doc-comment]').length === 1);
      await page.until('Archived gone', () => !document.querySelector('#task-sheet [data-archived-comments]'));
      await page.until('marked once more', markCount, 1);

      await page.click('#task-sheet nav[aria-label="Documents"] button', 'Outline');
      await page.until('the outline', headingIs, 'Outline: Invoice CSV export');
      assert.deepEqual(await page.eval(marked), {}, 'a passage no longer in the document is not marked');
      assert.deepEqual(await page.until('its comment in the panel', () => {
        const shown = [...document.querySelectorAll<HTMLElement>('#task-sheet [data-comments-panel] > ul > li[data-doc-comment]')].map((li) => li.dataset.docComment);
        return shown.length ? shown : null;
      }), [STALE.id]);
      await page.click(`${PANEL} li[data-doc-comment="${STALE.id}"] [data-comment-passage]`);
      await page.until('its heading in view', () => {
        const h = [...document.querySelectorAll('#task-sheet [data-document-body] h2')].find((x) => x.textContent === 'Phase 2: GET /invoices/export streams a month');
        const box = document.querySelector('#task-sheet [data-document-body]')!.getBoundingClientRect();
        const r = h?.getBoundingClientRect();
        return !!r && r.top >= box.top - 1 && r.bottom <= box.bottom;
      });
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-next-steps]')?.textContent?.includes('not sent')), false, 'no word on comments by the next steps');

      await page.key('1');
      await page.until('Overview', () => !!document.querySelector('#task-sheet [data-ux-section="workflow"] [data-next-steps]'));
      assert.equal(await page.eval(() => !!document.querySelector('#task-sheet [data-later]')), false, 'comments are not under Later');
      assert.equal(await page.eval(() => document.querySelector('#task-sheet')!.textContent.includes('Name the batch size')), false, 'nor anywhere on Overview');
    },
  },
  {
    name: 'CM.1a a comment on the whole document is written in the field under the panel\'s comments: Enter adds it with no passage, Shift+Enter breaks the line, and it is listed as about the whole document',
    scenario: 'workflow',
    async run({ page, mock, shot }) {
      await page.goto(docUrl(mock, DESIGN));
      await page.until('the design discussion', headingIs, 'Design Discussion: Invoice CSV export');
      await page.click(`${PANEL} [data-whole-comment-field]`);
      await page.type('Shorter overall.');
      await page.key('Enter', { shift: true });
      await page.type('Drop the mockup.');
      await page.key('Enter');
      const kept = await until('the comment kept', async () => (await commentsOf(mock)).find((c) => c.path === DESIGN));
      assert.deepEqual([kept.version, kept.quote, kept.heading, kept.text, kept.sentAt], [3, null, null, 'Shorter overall.\nDrop the mockup.', null]);
      await page.until('the field emptied', (sel: string) => document.querySelector<HTMLTextAreaElement>(sel)?.value === '', `${PANEL} [data-whole-comment-field]`);
      await page.until('in the panel', () => document.querySelectorAll('#task-sheet [data-comments-panel] > ul > li[data-doc-comment]').length === 1);
      assert.deepEqual(await page.eval(panel), [['Whole document', 'Shorter overall.\nDrop the mockup.']]);
      assert.deepEqual(await page.eval(marked), {}, 'nothing marked in the document');
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-send-comments]')?.textContent), 'Send 1 comment');
      await shot('document-whole-comment');
    },
  },
  {
    name: 'CM.2 Send 3 comments in the panel posts one /rpi:rpi update command naming the document on its own first line, then each passage comment with its heading and passage quoted and the whole-document one as such, held with Undo; once sent they move under Sent with the time, the marks go, and the comment on another document stays open; a sent one archived goes back under Sent when restored; while Claude works it is disabled and says why',
    scenario: 'workflow',
    clock: 'fast',
    async run({ page, mock, shot }) {
      const units = 'Amounts are written in major units with two decimals';
      const first = docComment('c-stream', DESIGN, 'Stream or build the file first?', PASSAGE, 'Say what a failed stream leaves behind.', 3);
      const second = docComment('c-units', DESIGN, 'Resolved Design Questions', units, 'Keep minor units in the file too.', 3);
      const third = docComment('c-whole', DESIGN, null, null, 'Shorter overall.', 3);
      await mock.post('/mock/patch', { id: 's-export', patch: { review: { comments: [STALE, first, second, third], outdated: {} }, status: 'working', activity: { step: 'Bash: pnpm test', since: Date.now() } } });
      await page.goto(docUrl(mock, DESIGN));
      await page.until('the design discussion', headingIs, 'Design Discussion: Invoice CSV export');
      await page.until('both passages marked', () => new Set([...document.querySelectorAll<HTMLElement>('#task-sheet [data-document-body] mark[data-comment]')].map((m) => m.dataset.comment)).size === 2);
      assert.deepEqual(await page.eval(marked), { 'c-stream': PASSAGE, 'c-units': units });
      const button = '#task-sheet [data-send-comments]';
      assert.deepEqual(await page.until('the send button', (b: string) => {
        const el = document.querySelector<HTMLButtonElement>(b);
        return el && [el.textContent, el.disabled, el.dataset.explain];
      }, button), ['Send 3 comments', true, 'Claude is at work; this can go once its turn has ended.']);

      await mock.post('/mock/patch', { id: 's-export', patch: { status: 'idle', activity: null } });
      await page.until('the button enabled', (b: string) => document.querySelector<HTMLButtonElement>(b)?.disabled === false, button);
      await page.click(button);
      const [held] = await until('the held toast', () => page.eval(toastsOf, 'undo'));
      assert.match(held.text, new RegExp(`^Sending: /rpi:rpi update ${DESIGN.replaceAll('.', '\\.')}`));
      const message = [
        `/rpi:rpi update ${DESIGN}`,
        `Under “Stream or build the file first?”:\n> ${PASSAGE}\n\nSay what a failed stream leaves behind.`,
        `Under “Resolved Design Questions”:\n> ${units}\n\nKeep minor units in the file too.`,
        'About the whole document:\nShorter overall.',
        BOARD_HANDOFF,
      ].join('\n\n');
      const [post] = await logged(mock, 'the comments sent', (e) => e.action === 'answer' && e.sessionId === 's-export', POSTED_MS);
      assert.deepEqual(post.body, { key: null, text: message, comments: ['c-stream', 'c-units', 'c-whole'] });
      assert.deepEqual(await until('typed', async () => (await typedInto(mock, 's-export')).length && typedInto(mock, 's-export')), [message], 'typed as it is, one message');
      const after = await until('marked sent', async () => {
        const all = await commentsOf(mock);
        return all.filter((c) => c.sentAt !== null).length === 3 && all;
      });
      assert.deepEqual(after.filter((c) => c.sentAt === null).map((c) => c.id), [STALE.id], 'only the comment on the outline stays open');
      await page.until('the button gone', (b: string) => !document.querySelector(b), button);
      assert.deepEqual(await page.eval(marked), {});
      assert.deepEqual(await page.eval(panel), []);
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-sent-comments] summary')?.textContent), 'Sent · 3');
      await page.click('#task-sheet [data-sent-comments] summary');
      const sentList = await page.until('the sent ones', () => {
        const items = [...document.querySelectorAll<HTMLElement>('#task-sheet [data-sent-comments] li[data-sent]')];
        return items.length === 3 && items.every((li) => li.checkVisibility()) && items.map((li) => [li.querySelector('p')?.textContent, li.textContent?.includes('Sent ') && li.textContent.includes('on v3')]);
      });
      assert.deepEqual(sentList, [['Say what a failed stream leaves behind.', true], ['Keep minor units in the file too.', true], ['Shorter overall.', true]]);
      await shot('document-comments-sent');
      assert.deepEqual(await page.eval(counts), { [OUTLINE]: '1 comment' });

      await page.click('#task-sheet [data-sent-comments] li[data-doc-comment="c-whole"] button', 'Archive');
      await until('the sent comment archived', async () => typeof (await commentsOf(mock)).find((c) => c.id === 'c-whole')?.archivedAt === 'number');
      await page.until('Sent · 2', () => document.querySelector('#task-sheet [data-sent-comments] summary')?.textContent === 'Sent · 2');
      await page.click('#task-sheet [data-archived-comments] summary');
      await page.click('#task-sheet [data-archived-comments] li[data-doc-comment="c-whole"] button', 'Restore');
      await page.until('back under Sent', () => document.querySelector('#task-sheet [data-sent-comments] summary')?.textContent === 'Sent · 3' && !document.querySelector('#task-sheet [data-archived-comments]'));
    },
  },
  {
    name: "CM.3 by the phase strip Overview and the Documents tab offer rpi's next steps for the flow, each /clear first and the command, with the note that the board moves the phases, once Claude has started the new conversation, but Implement the next phase in the conversation under way; a /clear never taken sends nothing more and says so; while Claude works they are disabled",
    scenario: 'workflow',
    clock: 'fast',
    expectedErrors: [/status of 400/],
    async run({ page, mock, shot }) {
      const sent = (command: string) => `${command}\n\n${BOARD_HANDOFF}`;
      const byOpus = (command: string) => `${command}\nLaunch outline-implementer-agent with model: opus.\n\n${BOARD_HANDOFF}`;
      await page.goto(`${mock.url}/s/s-export/documents`);
      await page.until('the steps', () => !!document.querySelector('#task-sheet [data-next-steps] button:not(:disabled)'));
      assert.deepEqual(await page.eval(steps), ['*Implement the next phase']);
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-next-steps] input')), null, 'no choice to stay in the conversation');
      assert.equal(await page.eval(() => document.querySelector<HTMLSelectElement>('#task-sheet [data-implementer-model] select')?.selectedOptions[0]?.textContent), 'Opus', 'Opus implements unless another is picked');
      assert.match(await page.eval(explainOf, '#task-sheet [data-next-steps] button') ?? '', /Sends Claude, with 5 s to undo: “\/rpi:rpi implement \.pitwall\/artifacts\/invoice-export”/);
      await shot('documents-next-steps');
      const before = (await stateOf(mock, 's-export')).conversation;
      await page.click('#task-sheet [data-next-steps] button', 'Implement the next phase');
      const [held] = await until('the held toast', () => page.eval(toastsOf, 'undo'));
      assert.equal(held.text.split('\n')[0], `Sending: /rpi:rpi implement ${DIR}`);
      const [post] = await logged(mock, 'the step sent', (e) => e.action === 'answer' && e.sessionId === 's-export', POSTED_MS);
      assert.deepEqual(post.body, { key: null, text: byOpus(`/rpi:rpi implement ${DIR}`) });
      assert.deepEqual(await typedInto(mock, 's-export'), [byOpus(`/rpi:rpi implement ${DIR}`)], 'no /clear');
      assert.equal((await stateOf(mock, 's-export')).conversation, before, 'the same conversation');

      await page.goto(`${mock.url}/s/s-search-page/overview`);
      await page.until('the steps in Overview', () => !!document.querySelector('#task-sheet [data-ux-section="workflow"] [data-next-steps] button'));
      assert.deepEqual(await page.eval(steps), ['*PRD (disabled)', 'Outline (disabled)', 'Implement (disabled)'], 'Claude is at work');
      assert.ok(await page.eval(() => !!document.querySelector('#task-sheet [data-implementer-model]')), 'a model for the Implement step');
      await mock.post('/mock/patch', { id: 's-search-page', patch: { status: 'idle', activity: null } });
      await page.until('enabled', () => !document.querySelector('#task-sheet [data-next-steps] button:disabled'));
      await shot('overview-next-steps');
      await page.click('#task-sheet [data-next-steps] button', 'PRD');
      await logged(mock, 'the PRD step', (e) => e.action === 'answer' && e.sessionId === 's-search-page' && e.body.fresh === true, POSTED_MS);
      assert.deepEqual(await until('typed', async () => (await typedInto(mock, 's-search-page')).length === 2 && typedInto(mock, 's-search-page')),
        ['/clear', sent('/rpi:rpi make a PRD .pitwall/artifacts/search-page; flow: prd')]);

      await mock.post('/mock/clear-ignored', { on: true });
      await page.until('enabled again', () => !!document.querySelector('#task-sheet [data-next-steps] button:not(:disabled)'));
      await page.click('#task-sheet [data-next-steps] button', 'Outline');
      const [error] = await until('the refusal', () => page.eval(toastsOf, 'error'), 15_000);
      assert.equal(error.text, 'Not sent to Docs search page: Claude did not start a new conversation after /clear, so “/rpi:rpi make an outline .pitwall/artifacts/search-page; flow: prd” was not sent\nShow');
      assert.deepEqual(await typedInto(mock, 's-search-page'), ['/clear', sent('/rpi:rpi make a PRD .pitwall/artifacts/search-page; flow: prd'), '/clear'], 'nothing after the /clear');
    },
  },
  {
    name: 'CM.3a the model picked by the Implement step goes with it, and with the task\'s model picked no model is named',
    scenario: 'workflow',
    clock: 'fast',
    async run({ page, mock }) {
      const pick = (value: string) => page.eval((v) => {
        const s = document.querySelector<HTMLSelectElement>('#task-sheet [data-implementer-model] select')!;
        s.value = v;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
      await mock.post('/mock/patch', { id: 's-search-page', patch: { status: 'idle', activity: null } });
      await page.goto(`${mock.url}/s/s-search-page/overview`);
      await page.until('enabled', () => !!document.querySelector('#task-sheet [data-next-steps] button:not(:disabled)'));
      await pick('fable');
      await page.click('#task-sheet [data-next-steps] button', 'Implement');
      await until('typed', async () => (await typedInto(mock, 's-search-page')).length === 2);
      assert.deepEqual(await typedInto(mock, 's-search-page'),
        ['/clear', `/rpi:rpi implement .pitwall/artifacts/search-page; flow: prd\nLaunch outline-implementer-agent with model: fable.\n\n${BOARD_HANDOFF}`]);

      await page.until('enabled again', () => !!document.querySelector('#task-sheet [data-next-steps] button:not(:disabled)'));
      await pick('');
      await page.click('#task-sheet [data-next-steps] button', 'Implement');
      await until('typed again', async () => (await typedInto(mock, 's-search-page')).length === 4);
      assert.equal((await typedInto(mock, 's-search-page'))[3], `/rpi:rpi implement .pitwall/artifacts/search-page; flow: prd\n\n${BOARD_HANDOFF}`);
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
    name: 'CM.5 a Wall tile counts its task\'s drafts under Later quietly, Later 1 then Later 2 as another is kept; the comments on its documents are not counted, and a task with no drafts shows no count',
    scenario: 'workflow',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      const later = () => Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-tile]')]
        .flatMap((t) => {
          const c = t.querySelector('[data-later-count]')?.textContent;
          return c ? [[t.dataset.session, c]] : [];
        }));
      assert.deepEqual(await page.eval(later), {}, 'the comment on the outline is not a draft');
      const draft = (id: string, text: string) => ({ id, text, auto: false, armedAt: null, at: Date.now() });
      await mock.post('/mock/patch', { id: 's-export', patch: { parked: [draft('k1', 'Also the refunds.')] } });
      await page.until('Later 1', () => document.querySelector('[data-tile][data-session="s-export"] [data-later-count]')?.textContent === 'Later 1');
      await mock.post('/mock/patch', { id: 's-export', patch: { parked: [draft('k1', 'Also the refunds.'), draft('k2', 'Also the credit notes.')] } });
      await page.until('Later 2', () => document.querySelector('[data-tile][data-session="s-export"] [data-later-count]')?.textContent === 'Later 2');
      await shot('wall-later-count');
    },
  },
  {
    name: 'CM.6 a document whose later phases are under way offers Rework later phases: it marks them outdated, amber on the phase strip, and sends the rework of the first after a /clear; the outdated one is the only next step; its mark goes once a newer version of its document settles; Implement\'s rework fixes the code and takes its mark off once sent',
    scenario: 'workflow',
    clock: 'fast',
    async run({ page, mock, shot }) {
      await page.goto(docUrl(mock, OUTLINE));
      await page.until('the outline', headingIs, 'Outline: Invoice CSV export');
      assert.match(await page.until('Rework later phases on the outline', explainOf, '#task-sheet [data-rework-later]') ?? '', /^Marks Implement outdated/);
      await page.click(`#task-sheet nav[aria-label="Documents"] button[data-document="${RESEARCH}"]`);
      await page.until('the research', headingIs, 'Research: Invoice CSV export');
      assert.match(await page.until('Rework later phases on the research', explainOf, '#task-sheet [data-rework-later]') ?? '', /^Marks Design discussion, Outline and Implement outdated/);

      await page.click(`#task-sheet nav[aria-label="Documents"] button[data-document="${DESIGN}"]`);
      await page.until('the design discussion', headingIs, 'Design Discussion: Invoice CSV export');
      await page.until('Rework later phases enabled', () => document.querySelector<HTMLButtonElement>('#task-sheet [data-rework-later]')?.disabled === false);
      assert.match(await page.eval(explainOf, '#task-sheet [data-rework-later]') ?? '', /^Marks Outline and Implement outdated/);
      await page.click('#task-sheet [data-rework-later]', 'Rework later phases');
      const marks = await until('the marks', async () => {
        const o = await outdatedOf(mock);
        return Object.keys(o).length === 2 && o;
      });
      assert.deepEqual(Object.fromEntries(Object.entries(marks).map(([p, m]) => [p, [m.because, m.version]])), { outline: [DESIGN, 1], implement: [DESIGN, null] });
      await page.until('outdated on the strip', (want: string) => JSON.stringify([...document.querySelectorAll<HTMLElement>('#task-sheet [data-phase-strip] li[data-outdated]')].map((li) => li.dataset.phase)) === want, JSON.stringify(['outline', 'implement']));
      assert.equal(await page.eval(explainOf, '#task-sheet [data-phase-strip] li[data-phase="outline"]'), 'Outdated: 04-design-discussion-invoice-export.md changed after it was written');
      const outlineRework = [
        `/rpi:rpi update ${OUTLINE}`,
        `\`${DESIGN}\` changed after this document was written. Bring this document in line with the latest version of each and keep what still holds.`,
        '',
        BOARD_HANDOFF,
      ].join('\n');
      const [post] = await logged(mock, 'the rework sent', (e) => e.action === 'answer' && e.sessionId === 's-export', POSTED_MS);
      assert.deepEqual(post.body, { key: null, text: outlineRework, fresh: true, rework: 'outline' });
      assert.deepEqual(await until('typed', async () => (await typedInto(mock, 's-export')).length === 2 && typedInto(mock, 's-export')), ['/clear', outlineRework]);
      await page.until('the rework as the only next step', (want: string) => JSON.stringify([...document.querySelectorAll<HTMLButtonElement>('#task-sheet [data-next-steps] button')].map((b) => `${b.dataset.variant === 'primary' ? '*' : ''}${b.textContent}`)) === want, JSON.stringify(['*Rework Outline']));
      await shot('documents-outdated');

      await page.goto(`${mock.url}/`);
      await page.until('the tile chip', () => document.querySelector('[data-tile][data-session="s-export"] [data-workflow-chip]')?.textContent === 'RPI · Rework Outline');

      const outline = await (await fetch(`${mock.url}/api/sessions/s-export/documents/${OUTLINE}`)).text();
      await mock.post('/mock/document', { id: 's-export', path: OUTLINE, text: outline.replace('## Open Questions', '## Open Questions\n\n- Does the export follow the new design?') });
      await until('the outline\'s mark gone once its new version settled', async () => {
        const o = await outdatedOf(mock);
        return !o.outline && !!o.implement;
      }, 15_000);
      await page.goto(`${mock.url}/s/s-export/overview`);
      await page.until('Rework Implement in Overview', () => document.querySelector<HTMLButtonElement>('#task-sheet [data-ux-section="workflow"] [data-next-steps] button')?.textContent === 'Rework Implement');
      assert.deepEqual(await page.eval(stripOutdated), ['implement']);
      await page.until('enabled', () => document.querySelector<HTMLButtonElement>('#task-sheet [data-next-steps] button')?.disabled === false);
      await page.click('#task-sheet [data-next-steps] button', 'Rework Implement');
      const implementRework = [
        `/rpi:rpi fix the implementation ${DIR}`,
        `\`${DESIGN}\` changed after the code was written, and \`${OUTLINE}\` was reworked since to match it. Bring the code and its tests in line with the outline, \`${OUTLINE}\`, and keep what still holds.`,
        '',
        BOARD_HANDOFF,
      ].join('\n');
      const [fix] = await logged(mock, 'the implement rework sent', (e) => e.action === 'answer' && e.sessionId === 's-export' && e.body.rework === 'implement', POSTED_MS);
      assert.deepEqual(fix.body, { key: null, text: implementRework, fresh: true, rework: 'implement' });
      await until('no mark left once sent', async () => !Object.keys(await outdatedOf(mock)).length, POSTED_MS);
      await page.until('the strip without outdated phases', () => !document.querySelector('#task-sheet [data-phase-strip] li[data-outdated]'));
      await page.until('the usual next step again', () => document.querySelector('#task-sheet [data-next-steps] button')?.textContent === 'Implement the next phase');
    },
  },
  {
    name: 'CM.6a the request, whose phase the research questions stand for, offers Rework later phases too: it marks the research questions and every later phase outdated, and the rework of the research questions is the only next step',
    scenario: 'workflow',
    clock: 'fast',
    async run({ page, mock }) {
      await page.goto(docUrl(mock, REQUEST));
      await page.until('the request', headingIs, 'Original Request: Invoice CSV export');
      await page.until('Rework later phases enabled', () => document.querySelector<HTMLButtonElement>('#task-sheet [data-rework-later]')?.disabled === false);
      assert.match(await page.eval(explainOf, '#task-sheet [data-rework-later]') ?? '', /^Marks Questions, Research, Design discussion, Outline and Implement outdated/);
      await page.click('#task-sheet [data-rework-later]', 'Rework later phases');
      const marks = await until('the marks', async () => {
        const o = await outdatedOf(mock);
        return Object.keys(o).length === 5 && o;
      });
      assert.deepEqual(Object.fromEntries(Object.entries(marks).map(([p, m]) => [p, m.because])),
        { questions: REQUEST, research: REQUEST, 'design-discussion': REQUEST, outline: REQUEST, implement: REQUEST });
      await page.until('outdated on the strip', (want: string) => JSON.stringify([...document.querySelectorAll<HTMLElement>('#task-sheet [data-phase-strip] li[data-outdated]')].map((li) => li.dataset.phase)) === want,
        JSON.stringify(['questions', 'research', 'design-discussion', 'outline', 'implement']));
      const questionsRework = [
        `/rpi:rpi update ${QUESTIONS}`,
        `\`${REQUEST}\` changed after this document was written. Bring this document in line with the latest version of each and keep what still holds.`,
        '',
        BOARD_HANDOFF,
      ].join('\n');
      const [post] = await logged(mock, 'the rework sent', (e) => e.action === 'answer' && e.sessionId === 's-export', POSTED_MS);
      assert.deepEqual(post.body, { key: null, text: questionsRework, fresh: true, rework: 'questions' });
      await page.until('the rework as the only next step', (want: string) => JSON.stringify([...document.querySelectorAll<HTMLButtonElement>('#task-sheet [data-next-steps] button')].map((b) => `${b.dataset.variant === 'primary' ? '*' : ''}${b.textContent}`)) === want, JSON.stringify(['*Rework Questions']));

      await page.click(`#task-sheet nav[aria-label="Documents"] button[data-document="${QUESTIONS}"]`);
      const banner = await page.until('the banner on the research questions', () => document.querySelector<HTMLElement>('#task-sheet [data-outdated-banner]')?.innerText.replace(/\s+/g, ' '));
      assert.equal(banner, 'Outdated: Original Request: Invoice CSV export changed after this was written. Rework now Keep as is');
    },
  },
  {
    name: 'CM.7 an outdated document says what changed after it was written, with Rework now and Keep as is; Keep as is takes its mark off and leaves the rest; Rework later phases goes only when a send can, marking nothing otherwise',
    scenario: 'workflow',
    clock: 'fast',
    async run({ page, mock, shot }) {
      await mock.post('/mock/patch', { id: 's-export', patch: { status: 'working', activity: { step: 'Bash: pnpm test', since: Date.now() } } });
      await page.goto(docUrl(mock, RESEARCH));
      await page.until('the research', headingIs, 'Research: Invoice CSV export');
      assert.deepEqual(await page.until('Rework later phases, disabled', () => {
        const b = document.querySelector<HTMLButtonElement>('#task-sheet [data-rework-later]');
        return b && [b.disabled, b.dataset.explain];
      }), [true, 'Claude is at work; this can go once its turn has ended.']);
      await mock.post('/mock/patch', { id: 's-export', patch: { status: 'idle', activity: null } });
      await page.until('enabled', () => document.querySelector<HTMLButtonElement>('#task-sheet [data-rework-later]')?.disabled === false);
      await page.click('#task-sheet [data-rework-later]', 'Rework later phases');
      await until('three marks', async () => Object.keys(await outdatedOf(mock)).length === 3);
      await page.until('the held toast', () => !!document.querySelector('[data-toast] button'));
      await page.click('[data-toast] button', 'Undo');
      await page.until('outdated on the strip', (want: string) => JSON.stringify([...document.querySelectorAll<HTMLElement>('#task-sheet [data-phase-strip] li[data-outdated]')].map((li) => li.dataset.phase)) === want, JSON.stringify(['design-discussion', 'outline', 'implement']));

      await page.click(`#task-sheet nav[aria-label="Documents"] button[data-document="${DESIGN}"]`);
      const banner = await page.until('the banner', () => document.querySelector<HTMLElement>('#task-sheet [data-outdated-banner]')?.innerText.replace(/\s+/g, ' '));
      assert.equal(banner, 'Outdated: Research: Invoice CSV export changed after this was written. Rework now Keep as is');
      await shot('document-outdated-banner');
      await page.click('#task-sheet [data-outdated-banner] button', 'Keep as is');
      await until('its mark off', async () => {
        const o = await outdatedOf(mock);
        return !o['design-discussion'] && !!o.outline && !!o.implement;
      });
      await page.until('the banner gone', () => !document.querySelector('#task-sheet [data-outdated-banner]'));
      assert.deepEqual(await page.eval(stripOutdated), ['outline', 'implement']);

      await page.click(`#task-sheet nav[aria-label="Documents"] button[data-document="${OUTLINE}"]`);
      await page.until('the outline\'s banner', () => !!document.querySelector('#task-sheet [data-outdated-banner]'));
      await page.until('Rework now enabled', () => document.querySelector<HTMLButtonElement>('#task-sheet [data-outdated-banner] [data-rework-now]')?.disabled === false);
      const before = (await typedInto(mock, 's-export')).length;
      await page.click('#task-sheet [data-outdated-banner] [data-rework-now]', 'Rework now');
      assert.deepEqual(await until('typed', async () => {
        const t = await typedInto(mock, 's-export');
        return t.length === before + 2 && t.slice(before);
      }, POSTED_MS), ['/clear', [
        `/rpi:rpi update ${OUTLINE}`,
        `\`${RESEARCH}\` changed after this document was written. Bring this document in line with the latest version of each and keep what still holds.`,
        '',
        BOARD_HANDOFF,
      ].join('\n')], 'the design discussion was kept, not reworked');
    },
  },
];
