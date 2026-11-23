import assert from 'node:assert/strict';
import { until } from '../cdp.ts';
import { logged, openSheetOf, POSTED_MS, sidewaysScroll, stateOf, type Check } from '../helpers.ts';
import type { Mock } from '../mock.ts';
import { select } from './comments.ts';

const DIR = '.pitwall/artifacts/invoice-export';
const DESIGN = `${DIR}/04-design-discussion-invoice-export.md`;
const OUTLINE = `${DIR}/05-structure-outline-invoice-export.md`;
const PASSAGE = 'Streaming starts the download at once';
const BODY = '#task-sheet [data-document-body]';

const docUrl = (mock: Mock, path: string, query = '') => `${mock.url}/s/s-export/documents/${encodeURIComponent(path)}${query}`;
const headingIs = (want: string) => document.querySelector('#task-sheet [data-document-body] h1')?.textContent === want;
const bodyText = () => document.querySelector<HTMLElement>('#task-sheet [data-document-body]')?.innerText ?? '';

// The version buttons of the shown entry, newest first, the pressed one starred; or the menu's options.
const picker = () => {
  const group = document.querySelector('#task-sheet [data-versions]');
  if (!group) return null;
  const select = group.querySelector('select');
  if (select) return [...select.options].map((o) => `${o.selected ? '*' : ''}${o.textContent}`);
  return [...group.querySelectorAll<HTMLButtonElement>('button')].map((b) => `${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}${b.textContent}`);
};

// The diff in Changes from one version to another, once it has a line starting with `sign`: its caption and its lines,
// each `+`, `-` or ` ` with its text, and the words marked in changed ones.
const changes = (range: string, sign: string) => {
  const box = document.querySelector<HTMLElement>('#task-sheet [data-changes]');
  const root = box?.querySelector('diffs-container')?.shadowRoot;
  const lines = [...root?.querySelectorAll<HTMLElement>('[data-line-type]') ?? []]
    .filter((l) => !l.hasAttribute('data-column-number') && !l.querySelector('[data-column-number]'))
    .map((l) => {
      const type = l.dataset.lineType ?? '';
      const sign = type === 'change-addition' ? '+' : type === 'change-deletion' ? '-' : ' ';
      return `${sign}${l.textContent?.trim() ?? ''}`;
    })
    .filter((l, i, all) => l.trim() && all.indexOf(l) === i);
  const words = [...root?.querySelectorAll('[data-diff-span]') ?? []].map((w) => w.textContent ?? '');
  if (box?.dataset.changes !== range || !lines.some((l) => l.startsWith(sign))) return null;
  return { caption: box.querySelector('p')?.textContent, lines, words };
};

const changed = () => [...document.querySelectorAll<HTMLElement>('#task-sheet nav[aria-label="Documents"] button')]
  .filter((b) => b.querySelector('[data-changed]')).map((b) => b.dataset.document);

const versionCounts = () => Object.fromEntries([...document.querySelectorAll<HTMLElement>('#task-sheet nav[aria-label="Documents"] button')]
  .flatMap((b) => {
    const v = b.querySelector('[data-version-count]')?.textContent;
    return v ? [[b.dataset.document, v]] : [];
  }));

const frameOf = () => {
  const f = document.querySelector('#task-sheet iframe');
  return f && `${f.getAttribute('src')} ${f.getAttribute('sandbox')}`;
};

const frameIs = (want: string) => {
  const f = document.querySelector('#task-sheet iframe');
  return !!f && `${f.getAttribute('src')} ${f.getAttribute('sandbox')}` === want;
};

const marked = () => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-document-body] mark[data-comment]')].map((m) => m.dataset.comment);

export const versions: Check[] = [
  {
    name: 'VER.1 a document Claude rewrote shows its version by it in the list and in its heading, with a quiet picker v3 · v2 · v1; an older version reads in place, read only, under its own URL that a reload keeps; Changes shows what changed from the version before, its lines and the words in them marked',
    scenario: 'workflow',
    async run({ page, mock, shot, themes }) {
      await page.goto(docUrl(mock, DESIGN));
      await page.until('the design discussion', headingIs, 'Design Discussion: Invoice CSV export');
      await page.until('the version in the list', () => !!document.querySelector('#task-sheet [data-version-count]'));
      assert.deepEqual(await page.eval(versionCounts), { [DESIGN]: 'v3' }, 'only a document with more than one version says so');
      assert.deepEqual(await page.until('the picker', picker), ['*v3', 'v2', 'v1']);
      assert.match(await page.eval(() => document.querySelector('#task-sheet [data-shown-version] header > span')?.textContent ?? ''), /^Design discussion · 04-design-discussion-invoice-export\.md · v3 · changed /);
      assert.match(await page.eval(bodyText), /\*\*Recommendation:\*\* stream|Recommendation: stream/);
      await shot('document-versions');

      await page.click('#task-sheet [data-versions] button', 'v2');
      await page.until('v2 under its own URL', (want: string) => location.pathname + location.search === want, `/s/s-export/documents/${encodeURIComponent(DESIGN)}?v=2`);
      await page.until('v2 read', () => document.querySelector<HTMLElement>('#task-sheet [data-document-body]')?.innerText.includes('build the file first'));
      assert.deepEqual(await page.eval(picker), ['v3', '*v2', 'v1']);
      assert.match(await page.eval(() => document.querySelector('#task-sheet [data-shown-version] header > span')?.textContent ?? ''), /· v2, an older version$/);
      assert.equal(await page.eval(() => document.querySelector('#task-sheet [data-shown-version] header a')?.getAttribute('href')), `/api/sessions/s-export/versions/2?path=${encodeURIComponent(DESIGN)}`);
      await page.goto(docUrl(mock, DESIGN, '?v=2'));
      await page.until('v2 again after a reload', () => document.querySelector<HTMLElement>('#task-sheet [data-document-body]')?.innerText.includes('build the file first'));
      assert.deepEqual(await page.eval(picker), ['v3', '*v2', 'v1']);

      await page.click('#task-sheet [data-show-changes]', 'Changes');
      const v2 = await page.until('the changes in v2', changes, '1-2', '+');
      assert.equal(v2.caption, 'Changes from v1 to v2');
      assert.ok(v2.lines.includes('+### Stream or build the file first?'), v2.lines.join('\n'));
      assert.ok(!v2.lines.some((l) => l.startsWith('-')), 'v2 only added');
      assert.equal(await page.eval(() => location.search), '?v=2&changes');

      await page.click('#task-sheet [data-versions] button', 'v3');
      const v3 = await page.until('the changes in v3', changes, '2-3', '-');
      assert.equal(v3.caption, 'Changes from v2 to v3');
      assert.deepEqual(v3.lines.filter((l) => l[0] !== ' '), [
        '-Streaming starts the download at once; building first can report a row count. **Recommendation:** build the file first, so the dialog can say how many rows it holds.',
        '+Streaming starts the download at once; building first can report a row count. **Recommendation:** stream.',
      ]);
      assert.ok(v3.words.some((w) => w.includes('stream')), `the words changed are marked: ${JSON.stringify(v3.words)}`);
      assert.equal(await page.eval(() => location.search), '?changes', 'the latest needs no version in its URL');
      await themes(() => shot('document-changes'));
      await page.click('#task-sheet [data-show-changes]', 'Changes');
      await page.until('the document again', headingIs, 'Design Discussion: Invoice CSV export');
      assert.deepEqual(await page.eval(picker), ['*v3', 'v2', 'v1']);
    },
  },
  {
    name: 'VER.2 a document rewritten on disk becomes a new version once it has settled, and is marked changed since you read it in the list; opening it shows what changed and the mark goes; one never opened here is not marked',
    scenario: 'workflow',
    async run({ page, mock }) {
      await page.goto(docUrl(mock, DESIGN));
      await page.until('the design discussion', headingIs, 'Design Discussion: Invoice CSV export');
      await page.click(`#task-sheet nav[aria-label="Documents"] button[data-document="${OUTLINE}"]`);
      await page.until('the outline', headingIs, 'Outline: Invoice CSV export');
      assert.deepEqual(await page.eval(changed), []);

      const design = await (await fetch(`${mock.url}/api/sessions/s-export/documents/${DESIGN}`)).text();
      const rewritten = design.replace('**Recommendation:** stream.', '**Recommendation:** stream, and write a partial file marker on failure.');
      await mock.post('/mock/document', { id: 's-export', path: DESIGN, text: rewritten });
      await mock.post('/mock/document', { id: 's-export', path: `${DIR}/03-research-invoice-export.md`, text: `${await (await fetch(`${mock.url}/api/sessions/s-export/documents/${DIR}/03-research-invoice-export.md`)).text()}\nOne more finding.\n` });
      await page.until('the mark', () => !!document.querySelector('#task-sheet [data-changed]'));
      assert.deepEqual(await page.eval(changed), [DESIGN], 'not the research, never read here');
      await until('v4 settled', async () => {
        const v = (await stateOf(mock, 's-export')).workflow.versions[DESIGN];
        return v.latest === 4 && v.settled;
      }, 15_000);
      assert.equal((await page.eval(versionCounts))[DESIGN], 'v4');
      assert.deepEqual((await (await fetch(`${mock.url}/api/sessions/s-export/versions?path=${encodeURIComponent(DESIGN)}`)).json()).map((v: { n: number }) => v.n), [1, 2, 3, 4]);
      assert.equal(await (await fetch(`${mock.url}/api/sessions/s-export/versions/4?path=${encodeURIComponent(DESIGN)}`)).text(), rewritten);

      await page.click(`#task-sheet nav[aria-label="Documents"] button[data-document="${DESIGN}"]`);
      const shown = await page.until('what changed', changes, '3-4', '+');
      assert.deepEqual(shown.lines.filter((l) => l[0] === '+'), ['+Streaming starts the download at once; building first can report a row count. **Recommendation:** stream, and write a partial file marker on failure.']);
      await page.until('the mark gone', () => !document.querySelector('#task-sheet [data-changed]'));

      await page.goto(docUrl(mock, DESIGN));
      await page.until('the design discussion', headingIs, 'Design Discussion: Invoice CSV export');
      assert.deepEqual(await page.eval(changed), [], 'read, and kept across a reload');
    },
  },
  {
    name: 'VER.3 a comment on an older version carries it: marked in that version and in any other that still has its passage; the panel says v2, now v3, and the comments sent tell Claude it was written on an older version',
    scenario: 'workflow',
    clock: 'fast',
    async run({ page, mock, shot }) {
      await page.goto(docUrl(mock, DESIGN, '?v=2'));
      await page.until('v2', () => document.querySelector<HTMLElement>('#task-sheet [data-document-body]')?.innerText.includes('build the file first'));
      await select(page, PASSAGE);
      await page.click(`${BODY} [data-comment-button]`, 'Comment');
      await page.until('the comment box', () => document.activeElement?.matches('#task-sheet [data-comment-note] textarea'));
      await page.type('Is the row count worth the wait?');
      await page.key('Enter');
      await page.until('the box to close', () => !document.querySelector('#task-sheet [data-comment-note]'));
      const kept = await until('the comment kept', async () => (await stateOf(mock, 's-export')).review.comments.find((c: { text: string }) => c.text === 'Is the row count worth the wait?'));
      assert.deepEqual([kept.path, kept.heading, kept.quote, kept.version], [DESIGN, 'Stream or build the file first?', PASSAGE, 2]);
      await page.until('marked in v2', () => document.querySelectorAll('#task-sheet [data-document-body] mark[data-comment]').length > 0);
      assert.deepEqual(await page.eval(marked), [kept.id]);

      await page.click('#task-sheet [data-versions] button', 'v3');
      await page.until('v3', () => document.querySelector<HTMLElement>('#task-sheet [data-document-body]')?.innerText.includes('Recommendation: stream'));
      await page.until('marked in v3 too, where its passage still stands', () => document.querySelectorAll('#task-sheet [data-document-body] mark[data-comment]').length > 0);
      assert.deepEqual(await page.eval(marked), [kept.id]);
      const caption = await page.until('the version in the panel', (id: string) => document.querySelector(`#task-sheet [data-comments-panel] li[data-doc-comment="${id}"] [data-comment-version]`)?.textContent, kept.id);
      assert.equal(caption, 'v2, now v3');
      await shot('comment-on-older-version');

      await page.until('Send enabled', () => document.querySelector<HTMLButtonElement>('#task-sheet [data-send-comments]')?.disabled === false);
      await page.click('#task-sheet [data-send-comments]');
      const [post] = await logged(mock, 'the comment sent', (e) => e.action === 'answer' && e.sessionId === 's-export', POSTED_MS);
      assert.equal(post.body.text.split('\n\n').slice(0, 3).join('\n\n'),
        `/rpi:rpi update ${DESIGN}\n\nUnder “Stream or build the file first?” (written on version 2; the document is at version 3 now, so the passage may have moved):\n> ${PASSAGE}\n\nIs the row count worth the wait?`);
    },
  },
  {
    name: 'VER.4 an artifact published again under its title is one entry with its latest version and a picker; an older version opens in the same sandboxed frame; Changes compares their visible text; a new version from Claude comes in on top, and with many the picker is a menu',
    scenario: 'workflow',
    async run({ page, mock, shot }) {
      await openSheetOf(page, mock, 's-export');
      const overview = await page.until('the artifact in Overview', () => {
        const shown = [...document.querySelectorAll<HTMLElement>('#task-sheet [data-ux-section="artifacts"] button')].map((b) => b.innerText.replace(/\s+/g, ' '));
        return shown.length ? shown : null;
      });
      assert.equal(overview.length, 1, 'the title once');
      assert.match(overview[0], /^How the export streams made .* · v3$/);
      assert.equal(await page.eval(() => [...document.querySelectorAll('#task-sheet [role="tab"]')].find((t) => t.textContent?.startsWith('Artifacts'))?.textContent), 'Artifacts (1) 4');
      await page.click('#task-sheet [data-ux-section="artifacts"] button');
      assert.equal(await page.until('the latest version', frameOf), '/api/sessions/s-export/artifacts/art-export-3 allow-scripts');
      assert.deepEqual(await page.eval(picker), ['*v3', 'v2', 'v1']);
      await shot('artifact-versions');

      await page.click('#task-sheet [data-versions] button', 'v1');
      await page.until('v1 in the same frame', frameIs, '/api/sessions/s-export/artifacts/art-export-1 allow-scripts');
      assert.equal(await page.eval(() => location.pathname), '/s/s-export/artifacts/art-export-1');
      assert.equal(await page.eval(() => !!document.querySelector('#task-sheet [data-show-changes]')), false, 'nothing before v1');

      await page.click('#task-sheet [data-versions] button', 'v2');
      await page.click('#task-sheet [data-show-changes]', 'Changes');
      const text = await page.until('the changes in its text', changes, '1-2', '+');
      assert.deepEqual(text.lines.filter((l) => l[0] !== ' '), [
        '-• The server builds the whole file',
        '+• The server reads 50 invoices at a time',
        '+• Each page of rows is written as it comes',
        '-Building first lets the dialog count the rows.',
        '+Streaming starts the download at once.',
      ]);
      assert.equal(await page.eval(() => !!document.querySelector('#task-sheet iframe')), false, 'in place of the frame');
      assert.equal(await (await fetch(`${mock.url}/api/sessions/s-export/artifacts/art-export-2/text`)).text(), [
        'How the export streams', 'How the export streams', '• The page asks for a month', '• The server reads 50 invoices at a time', '• Each page of rows is written as it comes', '• The browser downloads it', 'Streaming starts the download at once.',
      ].join('\n'), 'its visible text: no script, no style');
      await shot('artifact-changes');

      const page4 = (await (await fetch(`${mock.url}/api/sessions/s-export/artifacts/art-export-3`)).text()).replace('The browser saves the file', 'The browser saves the file and shows its size');
      assert.deepEqual(await mock.post('/mock/artifact', { id: 's-export', title: 'How the export streams', html: page4 }), { id: (await stateOf(mock, 's-export')).artifacts.at(-1).id, version: 4 });
      await page.click('#task-sheet [role="tablist"][aria-label="Artifacts"] button');
      await until('v4 on top', async () => JSON.stringify(await page.eval(picker)) === JSON.stringify(['*v4', 'v3', 'v2', 'v1']));
      await mock.post('/mock/artifact', { id: 's-export', title: 'How the export streams', html: page4.replace('its size', 'its size in KB') });
      await page.click('#task-sheet [role="tablist"][aria-label="Artifacts"] button');
      assert.deepEqual(await until('a menu of five', async () => {
        const shown = await page.eval(picker);
        return shown?.length === 5 ? shown : null;
      }), ['*v5 (latest)', 'v4', 'v3', 'v2', 'v1']);
      await page.eval(() => {
        const s = document.querySelector<HTMLSelectElement>('#task-sheet [data-versions] select')!;
        s.value = '2';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.until('v2 from the menu', frameIs, '/api/sessions/s-export/artifacts/art-export-2 allow-scripts');
      assert.equal(await page.eval(() => [...document.querySelectorAll('#task-sheet [role="tab"]')].find((t) => t.textContent?.startsWith('Artifacts'))?.textContent), 'Artifacts (1) 4');
    },
  },
  {
    name: 'VER.5 narrow: the version picker and Changes fit over the document and the artifact, and nothing scrolls sideways',
    scenario: 'workflow',
    narrow: true,
    async run({ page, mock, shot }) {
      await page.goto(docUrl(mock, DESIGN, '?changes'));
      await until('the changes', () => page.eval(() => !!document.querySelector('#task-sheet [data-changes] diffs-container')));
      const list = `nav.${await page.eval(() => document.querySelector('#task-sheet nav[aria-label="Documents"]')!.className.split(' ')[0])}`;
      assert.deepEqual((await page.eval(sidewaysScroll)).filter((el) => el !== list), []);
      assert.ok(await page.eval(() => document.querySelector('#task-sheet [data-versions]')!.getBoundingClientRect().right <= innerWidth));
      await shot('document-changes-narrow');
      await page.goto(`${mock.url}/s/s-export/artifacts`);
      await page.until('the artifact', () => !!document.querySelector('#task-sheet iframe'));
      assert.ok(await page.eval(() => document.querySelector('#task-sheet [data-versions]')!.getBoundingClientRect().right <= innerWidth));
    },
  },
];
