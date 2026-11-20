import assert from 'node:assert/strict';
import { logged, openNewTask, openSheetOf, pickRepo, sidewaysScroll, stateOf, tiles, type Check } from '../helpers.ts';

const EXPORT_DIR = '.pitwall/artifacts/invoice-export';
const OUTLINE = `${EXPORT_DIR}/05-structure-outline-invoice-export.md`;

const chips = () => Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-tile]')]
  .map((t) => [t.dataset.session, t.querySelector('[data-workflow-chip]')?.textContent ?? null]));

const strip = () => [...document.querySelectorAll<HTMLElement>('#task-sheet [data-phase-strip] li')].map((li) => `${li.textContent}:${li.dataset.state}`);

const listed = () => [...document.querySelectorAll<HTMLElement>('#task-sheet nav[aria-label="Documents"] button')]
  .map((b) => [b.querySelector('strong')?.textContent, b.querySelector('span')?.textContent?.split(' · ')[0], b.getAttribute('aria-current') === 'true']);

const modelShown = () => document.querySelector<HTMLSelectElement>('#new-task [data-more-options] select')?.selectedOptions[0]?.textContent ?? null;

const modelIs = (want: string) => document.querySelector<HTMLSelectElement>('#new-task [data-more-options] select')?.selectedOptions[0]?.textContent === want;

const pickModel = (value: string) => {
  const select = document.querySelector<HTMLSelectElement>('#new-task [data-more-options] select')!;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
};

const headingIs = (want: string) => document.querySelector('#task-sheet [data-document-body] h1')?.textContent === want;
const bodyText = () => document.querySelector<HTMLElement>('#task-sheet [data-document-body]')?.innerText ?? '';

export const workflow: Check[] = [
  {
    name: 'RPI.1 New task › More › Workflow is None until RPI is picked; with RPI the task starts on one /rpi command naming its task directory, .pitwall/artifacts/<branch with / as ->, the hint says where its documents go, and the choice is kept for the next New task and a reload. The model starts at Opus with None and at Fable with RPI, following the workflow until one is picked, which then stays until the task is created',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      const picked = () => document.querySelector<HTMLInputElement>('#new-task [data-workflow] input:checked')?.parentElement?.textContent ?? null;
      assert.equal(await page.until('the Workflow choice', picked), 'None');
      await page.until('Opus with None', modelIs, 'Opus 5.5');
      await page.type('Add a CSV export of the invoices\nFinance wants a month per file.');
      await pickRepo(page, 'billing');
      await page.click('dialog#new-task input[placeholder="fix-login-redirect"]');
      await page.type('csv-export');
      await page.click('dialog#new-task input[placeholder="csv-export"]');
      await page.type('feature/csv-export');
      assert.equal(await page.eval(() => !!document.querySelector('#new-task [data-workflow-hint]')), false, 'no hint without a workflow');
      await page.click('#new-task [data-workflow] label', 'RPI');
      assert.equal(await page.until('the RPI hint', () => document.querySelector('#new-task [data-workflow-hint]')?.textContent ?? null),
        'Starts Claude on /rpi with the prompt; its documents go to .pitwall/artifacts/feature-csv-export, which git is told to ignore.');
      await page.until('Fable with RPI', modelIs, 'Fable 5.1');
      await shot('new-task-rpi');
      await page.key('Enter', { meta: true });
      const [created] = await logged(mock, 'the new task', (e) => e.method === 'POST' && e.path === '/api/worktrees');
      assert.deepEqual([created.body.workflow, created.body.prompt, created.body.branch, created.body.model], ['rpi', 'Add a CSV export of the invoices\nFinance wants a month per file.', 'feature/csv-export', 'fable']);
      const id = await page.until('its page', () => /^\/s\/([^/]+)\/overview$/.exec(location.pathname)?.[1] ?? null);
      assert.equal((await stateOf(mock, id)).firstPrompt,
        '/rpi:rpi Add a CSV export of the invoices; task directory: .pitwall/artifacts/feature-csv-export\nFinance wants a month per file.', 'shown without the note to rpi');

      await openNewTask(page);
      assert.equal(await page.until('the choice kept', picked), 'RPI');
      await page.key('Escape');
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      await openNewTask(page);
      assert.equal(await page.until('the choice kept over a reload', picked), 'RPI');
      await page.until('Fable again', modelIs, 'Fable 5.1');
      await page.click('#new-task [data-workflow] label', 'None');
      await page.until('Opus again with None', modelIs, 'Opus 5.5');
      await shot('new-task-none');
      await page.eval(pickModel, 'sonnet');
      await page.click('#new-task [data-workflow] label', 'RPI');
      await page.until('the RPI hint again', () => !!document.querySelector('#new-task [data-workflow-hint]'));
      assert.equal(await page.eval(modelShown), 'Sonnet 5.5', 'a model picked stays when the workflow changes');
      await page.click('#new-task [data-workflow] label', 'None');
      await page.click('dialog#new-task textarea');
      await page.type('No workflow');
      await page.click('dialog#new-task input[placeholder="fix-login-redirect"]');
      await page.type('plain-task');
      await page.key('Enter', { meta: true });
      const [plain] = await logged(mock, 'the plain task', (e) => e.method === 'POST' && e.path === '/api/worktrees' && e.body.name === 'plain-task');
      assert.deepEqual([plain.body.workflow, plain.body.model], [undefined, 'sonnet']);
      const other = await page.until('its page', () => /^\/s\/([^/]+)\/overview$/.exec(location.pathname)?.[1] ?? null);
      assert.equal((await stateOf(mock, other)).firstPrompt, 'No workflow');
      await openNewTask(page);
      await page.until('Opus for the next task', modelIs, 'Opus 5.5');
    },
  },
  {
    name: 'RPI.2 a Wall tile names the phase its rpi documents are at in a quiet chip, Implement 1/3 for the outline one phase in and Research for the PRD flow at research; a task without documents has none and no Documents tab, and 5 does nothing there',
    scenario: 'workflow',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', tiles);
      await page.until('the chips', () => document.querySelectorAll('[data-tile] [data-workflow-chip]').length === 2);
      const shown = await page.eval(chips);
      assert.equal(shown['s-export'], 'RPI · Implement 1/3');
      assert.equal(shown['s-search-page'], 'RPI · Research');
      assert.equal(Object.entries(shown).filter(([, v]) => v).length, 2, 'only the RPI tasks');
      await shot('wall-rpi-chips');
      await openSheetOf(page, mock, 's-cart');
      assert.equal(await page.eval(() => [...document.querySelectorAll('#task-sheet [role="tab"]')].some((t) => t.textContent?.startsWith('Documents'))), false);
      assert.equal(await page.eval(() => !!document.querySelector('#task-sheet [data-phase-strip]')), false);
      await page.key('5');
      assert.equal(await page.eval(() => location.pathname), '/s/s-cart/overview');
    },
  },
  {
    name: 'RPI.3 Overview and Documents show the phase strip; 5 opens Documents on the current phase\'s document, the list in workflow order with types; Markdown renders without its front matter, a Mermaid diagram is drawn (Mermaid loads only then, from the board), a relative link opens the research in the tab, the mockup opens in a sandboxed frame and the image beside the documents shows',
    scenario: 'workflow',
    async run({ page, mock, shot, themes, holds }) {
      await openSheetOf(page, mock, 's-export');
      const phases = ['Questions:done', 'Research:done', 'Design discussion:done', 'Outline:done', 'Implement1/3:current'];
      await page.until('the strip on Overview', () => !!document.querySelector('#task-sheet [data-phase-strip] li'));
      assert.deepEqual(await page.eval(strip), phases);
      await shot('overview-rpi');
      assert.equal(await page.eval(() => [...document.querySelectorAll('#task-sheet [role="tab"]')].find((t) => t.textContent?.startsWith('Documents'))?.textContent), 'Documents (5) 5');
      const mermaid = () => page.requests.filter((u) => /\/assets\/mermaid/.test(u)).length;
      assert.equal(mermaid(), 0, 'no Mermaid on Overview');

      await page.key('5');
      await page.until('Documents', () => location.pathname === '/s/s-export/documents' && !!document.querySelector('#task-sheet [data-document-body] h1'));
      assert.deepEqual(await page.eval(listed), [
        ['Original Request: Invoice CSV export', 'Request', false],
        ['Research Questions: Invoice CSV export', 'Research questions', false],
        ['Research: Invoice CSV export', 'Research', false],
        ['Design Discussion: Invoice CSV export', 'Design discussion', false],
        ['Outline: Invoice CSV export', 'Outline', true],
        ['diagram-export-states.svg', 'Image', false],
        ['mockup-export-dialog.html', 'Mockup', false],
      ]);
      assert.deepEqual(await page.eval(strip), phases, 'the strip on Documents too');
      const body = await page.eval(bodyText);
      assert.match(body, /Implementation Overview/);
      assert.doesNotMatch(body, /identifier: acme/, 'no front matter');
      assert.equal(mermaid(), 0, 'no Mermaid for a document without a diagram');

      await page.click('#task-sheet nav[aria-label="Documents"] button', 'Design Discussion');
      await page.until('the design discussion', headingIs, 'Design Discussion: Invoice CSV export');
      const image = await page.until('the image beside it', () => {
        const img = document.querySelector<HTMLImageElement>('#task-sheet [data-document-body] img[alt="The export\'s states"]');
        return img?.complete && img.naturalWidth ? img.getAttribute('src') : null;
      });
      assert.equal(image, `/api/sessions/s-export/documents/${EXPORT_DIR}/diagram-export-states.svg`);
      await page.click('#task-sheet [data-document-body] a', 'the research');
      await page.until('the research, opened in the tab', (path: string) => document.querySelector('#task-sheet [data-document-body] h1')?.textContent === 'Research: Invoice CSV export' &&
        location.pathname === path, `/s/s-export/documents/${encodeURIComponent(`${EXPORT_DIR}/03-research-invoice-export.md`)}`);
      const diagram = await page.until('the diagram drawn', () => {
        const img = document.querySelector<HTMLImageElement>('#task-sheet [data-document-body] img[data-diagram]');
        return img?.complete && img.naturalWidth > 100 ? { pre: !!document.querySelector('#task-sheet [data-document-body] pre code')?.textContent?.includes('sequenceDiagram') } : null;
      });
      assert.deepEqual(diagram, { pre: false }, 'the code block gave way to the diagram');
      await page.eval(() => document.querySelector('#task-sheet [data-document-body] img[data-diagram]')!.setAttribute('data-kept', ''));
      await mock.post('/mock/patch', { id: 's-cart', patch: { lastMessage: 'Another task moved on meanwhile.' } });
      await holds('the document to stay as drawn while the board changes around it', 1500,
        () => page.eval(() => !!document.querySelector('#task-sheet [data-document-body] img[data-diagram][data-kept]')));
      assert.ok(mermaid() > 0, 'Mermaid loaded for the diagram');
      assert.deepEqual(page.requests.filter((u) => new URL(u).hostname !== '127.0.0.1' && !u.startsWith('data:')), [], 'nothing from another host');
      await themes(async () => {
        await page.until('the diagram drawn in this scheme', () => !!document.querySelector<HTMLImageElement>('#task-sheet [data-document-body] img[data-diagram]')?.naturalWidth);
        await shot('documents-research');
      });

      await page.click('#task-sheet nav[aria-label="Documents"] button', 'Design Discussion');
      await page.until('the design discussion', headingIs, 'Design Discussion: Invoice CSV export');
      await page.click('#task-sheet [data-document-body] a', 'the export dialog mockup');
      const frame = await page.until('the mockup in a sandboxed frame', () => {
        const f = document.querySelector('#task-sheet iframe');
        return f && { sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src')?.split('?')[0] };
      });
      assert.deepEqual(frame, { sandbox: 'allow-scripts', src: `/api/sessions/s-export/documents/${EXPORT_DIR}/mockup-export-dialog.html` });
      const served = await fetch(`${mock.url}${frame.src}`);
      assert.match(served.headers.get('content-security-policy') ?? '', /default-src 'none'/);
      assert.match(await served.text(), /Export invoices/);
      await page.click('#task-sheet [data-phase-strip] a', 'Research');
      await page.until('a phase of the strip opens its document', headingIs, 'Research: Invoice CSV export');
    },
  },
  {
    name: 'RPI.3b the PRD flow\'s strip names its technical design in full, each phase on one line',
    scenario: 'workflow',
    async run({ page, mock, shot }) {
      await openSheetOf(page, mock, 's-search-page');
      await page.until('the strip on Overview', () => !!document.querySelector('#task-sheet [data-phase-strip] li'));
      assert.deepEqual(await page.eval(strip), ['Questions:done', 'Research:current', 'PRD:next', 'Technical Design:next', 'Outline:next', 'Implement:next']);
      const heights = await page.eval(() => [...document.querySelectorAll('#task-sheet [data-phase-strip] li')].map((li) => li.getBoundingClientRect().height));
      assert.equal(new Set(heights).size, 1, `one line each: ${heights.join(', ')}`);
      await shot('overview-rpi-prd');
    },
  },
  {
    name: 'RPI.4 a document that changes on disk while it is open shows the change within the board\'s refresh where you were reading; the outline\'s next phase ticked moves the strip and the chip to Implement 2/3',
    scenario: 'workflow',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/s/s-export/documents/${encodeURIComponent(OUTLINE)}`);
      await page.until('the outline', headingIs, 'Outline: Invoice CSV export');
      const outline = await (await fetch(`${mock.url}/api/sessions/s-export/documents/${OUTLINE}`)).text();
      const long = outline.replace('## Open Questions', `${Array.from({ length: 60 }, (_, i) => `Note ${i + 1} on the order of the phases.`).join('\n\n')}\n\n## Open Questions`);
      await mock.post('/mock/document', { id: 's-export', path: OUTLINE, text: long });
      await page.until('the longer outline', () => document.querySelector<HTMLElement>('#task-sheet [data-document-body]')?.innerText.includes('Note 60'));
      const scrolled = await page.eval(() => {
        const el = document.querySelector<HTMLElement>('#task-sheet [data-document-body]')!;
        el.scrollTop = 600;
        return el.scrollTop;
      });
      assert.ok(scrolled > 0);
      await mock.post('/mock/document', { id: 's-export', path: OUTLINE, text: long.replace('- [ ] Phase 2', '- [x] Phase 2') });
      await page.until('the strip at 2 of 3', (s: string) => JSON.stringify([...document.querySelectorAll<HTMLElement>('#task-sheet [data-phase-strip] li')].map((li) => li.textContent).at(-1)) === s, JSON.stringify('Implement2/3'));
      await page.until('the ticked box', () => document.querySelectorAll('#task-sheet [data-document-body] input[type="checkbox"]:checked').length >= 3);
      assert.equal(await page.eval(() => document.querySelector<HTMLElement>('#task-sheet [data-document-body]')!.scrollTop), scrolled, 'the same place');
      await page.goto(`${mock.url}/`);
      await page.until('the chip at 2 of 3', () => document.querySelector('[data-tile][data-session="s-export"] [data-workflow-chip]')?.textContent === 'RPI · Implement 2/3');
    },
  },
  {
    name: 'RPI.5 narrow: Documents lists its entries in a row over the document, with the strip above, and nothing scrolls sideways',
    scenario: 'workflow',
    narrow: true,
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-export/documents`);
      await page.until('the outline', headingIs, 'Outline: Invoice CSV export');
      const list = `nav.${await page.eval(() => document.querySelector('#task-sheet nav[aria-label="Documents"]')!.className.split(' ')[0])}`;
      assert.deepEqual((await page.eval(sidewaysScroll)).filter((el) => el !== list), [], 'only the list scrolls sideways, as a row of tabs');
      assert.ok(await page.eval(() => {
        const nav = document.querySelector('#task-sheet nav[aria-label="Documents"]')!.getBoundingClientRect();
        const body = document.querySelector('#task-sheet [data-document-body]')!.getBoundingClientRect();
        const strip = document.querySelector('#task-sheet [data-phase-strip]')!.getBoundingClientRect();
        return strip.bottom <= nav.top + 1 && nav.bottom <= body.top + 1 && body.right <= innerWidth;
      }));
      await shot('documents-narrow');
    },
  },
];
