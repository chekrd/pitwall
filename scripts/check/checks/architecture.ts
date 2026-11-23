import assert from 'node:assert/strict';
import type { Page } from '../cdp.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logged, menuItems, openSheetOf, settled, sidewaysScroll, type Check } from '../helpers.ts';
import type { Mock } from '../mock.ts';
import { STANDING_MODEL } from '../../mock/architectureModels.ts';

const tabs = () => [...document.querySelectorAll('#task-sheet [role="tab"]')].map((t) => t.textContent);

// Waits until the canvas has drawn exactly these nodes and fitted them into view: React Flow marks its root
// `initialized` in the frame it places the camera, and the nodes and the camera stay put between two frames.
const until = async (page: Page, what: string, nodes: string[]) => {
  await page.until(what, async (want: string[]) => {
    const root = [...document.querySelectorAll('[data-canvas] *')].find((e) => e.shadowRoot)?.shadowRoot;
    const order = (a: string, b: string) => a.localeCompare(b);
    const ids = root ? [...root.querySelectorAll<HTMLElement>('.react-flow__node')].map((n) => n.dataset.id ?? '').sort(order) : [];
    if (!root?.querySelector('.react-flow.initialized') || ids.join() !== want.toSorted(order).join()) return false;
    const read = () => [root.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform, ...[...root.querySelectorAll<HTMLElement>('.react-flow__node')].map((n) => {
      const r = n.getBoundingClientRect();
      return n.style.visibility === 'visible' && r.width > 0 ? `${r.x},${r.y},${r.width}` : 'hidden';
    })].join(' ');
    const first = read();
    return new Promise<boolean>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(!first.includes('hidden') && first === read()))));
  }, nodes);
};

// A real click on an element in the canvas, once it has stopped moving. A node's action buttons are inert until React
// Flow sees the pointer enter the node, which it does only for a pointer coming from its own empty pane, so `hover`
// moves it onto the pane and then onto the node first.
async function clickInCanvas(page: Page, selector: string, hover?: string) {
  if (hover) {
    const over = await stable(page, hover);
    const pane = await page.until('an empty spot of the canvas', () => {
      const host = [...document.querySelectorAll('[data-canvas] *')].find((e) => e.shadowRoot);
      const r = host?.getBoundingClientRect();
      if (!host?.shadowRoot || !r) return null;
      const spots = [[r.left + 6, r.top + 6], [r.right - 6, r.top + 6], [r.left + 6, r.bottom - 6], [r.right - 30, r.bottom - 30]];
      const free = spots.find(([x, y]) => host.shadowRoot!.elementFromPoint(x, y)?.classList.contains('react-flow__pane'));
      return free ? { x: free[0], y: free[1] } : null;
    });
    await page.pointAt(pane.x, pane.y);
    await page.pointAt(over.x, over.y);
  }
  const at = await stable(page, selector);
  await page.pointAt(at.x, at.y, true);
}

async function stable(page: Page, selector: string) {
  let last = '';
  for (let i = 0; i < 100; i++) {
    const at = await page.eval((selector: string) => {
      const root = [...document.querySelectorAll('[data-canvas] *')].find((e) => e.shadowRoot)?.shadowRoot;
      const el = root?.querySelector<HTMLElement>(selector);
      if (!el || el.closest('[inert]')) return null;
      const r = el.getBoundingClientRect();
      return r.width ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
    }, selector);
    const now = JSON.stringify(at);
    if (at && now === last) return at;
    last = now;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${selector} never settled in the canvas`);
}

const colors = () => {
  const root = [...document.querySelectorAll('[data-canvas] *')].find((e) => e.shadowRoot)?.shadowRoot;
  return Object.fromEntries([...root?.querySelectorAll<HTMLElement>('.react-flow__node') ?? []].map((n) => [n.dataset.id, n.querySelector<HTMLElement>('[data-likec4-color]')?.dataset.likec4Color]));
};

const scheme = () => {
  const root = [...document.querySelectorAll('[data-canvas] *')].find((e) => e.shadowRoot)?.shadowRoot;
  return root?.querySelector<HTMLElement>('[data-mantine-color-scheme]')?.dataset.mantineColorScheme ?? null;
};

const summary = async (mock: Mock, id: string) => (await (await fetch(`${mock.url}/api/state`)).json()).sessions.find((s: { id: string }) => s.id === id).architecture;

async function openArchitecture(page: Page, mock: Mock, id: string) {
  await openSheetOf(page, mock, id);
  await page.until('the Architecture tab', () => [...document.querySelectorAll('#task-sheet [role="tab"]')].some((t) => t.textContent === 'Architecture 6'));
  await page.key('6');
  await page.until('the Architecture tab open', () => location.pathname.endsWith('/architecture'));
}

const CONTEXT = ['billing', 'customer', 'shop', 'stripe'];
const REGENERATED_CONTEXT = [...CONTEXT, 'ledger'];

const MORE = '#task-sheet header button[aria-label="Session actions"]';

async function openRegenerate(page: Page) {
  await page.click(MORE);
  await page.until('the menu', menuItems);
  await page.click(':popover-open button', 'Regenerate architecture…');
  await page.until('the dialog', () => !!document.querySelector<HTMLDialogElement>('dialog#regenerate-architecture')?.open);
}

// The open dialog's repositories, once it lists at least `count`.
const dialogRepos = (count = 1) => {
  const d = document.querySelector<HTMLDialogElement>('dialog#regenerate-architecture');
  const rows = d?.open ? [...d.querySelectorAll<HTMLElement>('[data-regenerate-repo]')].map((l) => {
    const box = l.querySelector('input')!;
    return { name: l.dataset.regenerateRepo, path: l.querySelector('code')?.textContent, checked: box.checked, disabled: box.disabled };
  }) : [];
  return rows.length >= count ? rows : null;
};

const confirmDisabled = () => document.querySelector<HTMLButtonElement>('dialog#regenerate-architecture [data-regenerate-confirm]')?.disabled;

const closeDialog = async (page: Page) => {
  await page.key('Escape');
  await page.until('the dialog closed', () => !document.querySelector<HTMLDialogElement>('dialog#regenerate-architecture')?.open);
};

async function folderTask(mock: Mock) {
  const home = await mock.home();
  const { sessionId } = await mock.post('/api/folder-tasks', { folder: `${home}/code`, name: 'ledger-sync', prompt: 'Book payments in the ledger' });
  await mock.post('/mock/open-worktree', { id: sessionId, repo: 'storefront' });
  await mock.post('/mock/open-worktree', { id: sessionId, repo: 'billing-api' });
  return sessionId as string;
}

const regenerations = (mock: Mock) => logged(mock, 'the regeneration', (e) => e.action === 'regenerate-architecture');
const CONTAINERS = ['billing', 'billing.api', 'billing.db', 'customer', 'shop', 'stripe'];
const COMPONENTS = ['billing.api', 'billing.api.invoices', 'billing.api.payments', 'billing.api.retries', 'billing.api.webhooks', 'billing.db', 'shop', 'stripe'];

export const architecture: Check[] = [
  {
    name: 'ARCH.1 a task whose worktree has a LikeC4 model gets an Architecture tab (6) that draws it on a canvas, with no request to any other host; a task without one has no tab and 6 does nothing',
    scenario: 'architecture',
    async run({ page, mock, shot, themes }) {
      await openSheetOf(page, mock, 's-cart');
      assert.ok(!(await page.eval(tabs)).some((t) => t?.startsWith('Architecture')), 'no tab without a model');
      await page.key('6');
      assert.equal(await page.eval(() => location.pathname), '/s/s-cart/overview');

      await openArchitecture(page, mock, 's-hooks');
      await until(page, 'the context diagram drawn', CONTEXT);
      assert.equal(await page.eval(() => document.querySelector<HTMLSelectElement>('[data-diagram-picker]')?.selectedOptions[0]?.textContent), 'Billing in context');
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll<HTMLOptionElement>('[data-diagram-picker] option')].map((o) => o.textContent)),
        ['Billing in context', 'Billing containers', 'Billing API components']);
      await themes(async (want) => {
        await page.until(`the canvas in ${want}`, (want: string) => {
          const root = [...document.querySelectorAll('[data-canvas] *')].find((e) => e.shadowRoot)?.shadowRoot;
          return root?.querySelector<HTMLElement>('[data-mantine-color-scheme]')?.dataset.mantineColorScheme === want;
        }, want);
        await shot('architecture-context');
      });
      assert.equal(await page.eval(scheme), await page.eval(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')));
      assert.match(await page.eval(() => {
        const root = [...document.querySelectorAll('[data-canvas] *')].find((e) => e.shadowRoot)?.shadowRoot;
        const title = root?.querySelector('.react-flow__node[data-id="billing"] .likec4-element-title');
        return title ? getComputedStyle(title).fontFamily : '';
      }), /Hanken Grotesk/, 'in the board\'s font');
      const elsewhere = page.requests.filter((u) => !/^(data|blob|about):/.test(u) && new URL(u).hostname !== '127.0.0.1');
      assert.deepEqual(elsewhere, [], 'nothing from another host');
      assert.ok(page.requests.some((u) => /\/assets\/ArchitectureCanvas-[^/]+\.js$/.test(u)), 'the canvas came from the board itself');
    },
  },
  {
    name: 'ARCH.2 the canvas goes into an element\'s diagram from its node, and back by the trail above it or the back button; the diagram is in the URL, so a reload keeps it; the picker goes to any diagram',
    scenario: 'architecture',
    async run({ page, mock, shot }) {
      await openArchitecture(page, mock, 's-hooks');
      await until(page, 'the context diagram drawn', CONTEXT);
      await clickInCanvas(page, '.react-flow__node[data-id="billing"] button[aria-label="Navigate to view"]', '.react-flow__node[data-id="billing"]');
      await page.until('the containers in the URL', () => location.search === '?view=billing');
      await until(page, 'the containers drawn', CONTAINERS);
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll('[data-diagram-up]')].map((b) => b.textContent)), ['Billing in context']);
      await clickInCanvas(page, '.react-flow__node[data-id="billing.api"] button[aria-label="Navigate to view"]', '.react-flow__node[data-id="billing.api"]');
      await page.until('the components in the URL', () => location.search === '?view=api');
      await until(page, 'the components drawn', COMPONENTS);
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll('[data-diagram-up]')].map((b) => b.textContent)), ['Billing in context', 'Billing containers']);
      await shot('architecture-components');

      await page.goto(`${mock.url}/s/s-hooks/architecture?view=api`);
      await until(page, 'the components after a reload', COMPONENTS);
      await page.click('[data-diagram-up]', 'Billing containers');
      await page.until('the containers again', () => location.search === '?view=billing');
      await until(page, 'the containers drawn again', CONTAINERS);
      await page.eval(() => navigation.back());
      await page.until('back on the components', () => location.search === '?view=api');
      await until(page, 'the components drawn again', COMPONENTS);

      await page.eval(() => {
        const select = document.querySelector<HTMLSelectElement>('[data-diagram-picker]')!;
        select.value = 'index';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.until('the overview from the picker', () => location.search === '?view=index');
      await until(page, 'the context drawn', CONTEXT);
    },
  },
  {
    name: 'ARCH.3 a click on an element opens its details over the canvas, with its description and technology; Esc closes them and stays on the tab',
    scenario: 'architecture',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-hooks/architecture?view=billing`);
      await until(page, 'the containers drawn', CONTAINERS);
      await clickInCanvas(page, '.react-flow__node[data-id="billing.api"] .likec4-element-title');
      const details = await page.until('the details', () => {
        const root = [...document.querySelectorAll('[data-canvas] *')].find((e) => e.shadowRoot)?.shadowRoot;
        return root?.querySelector<HTMLElement>('dialog[open]')?.innerText ?? null;
      });
      assert.match(details, /Billing API/);
      assert.match(details, /REST API for invoices and payments/);
      assert.match(details, /TECHNOLOGY\nNode\nHono/);
      await shot('architecture-details');
      await page.key('Escape');
      await page.until('the details closed', () => {
        const root = [...document.querySelectorAll('[data-canvas] *')].find((e) => e.shadowRoot)?.shadowRoot;
        return !root?.querySelector('dialog[open]');
      });
      assert.equal(await page.eval(() => location.pathname), '/s/s-hooks/architecture');
    },
  },
  {
    name: 'ARCH.4 This task\'s changes marks what the task\'s model adds green and changes amber, in the URL, and lists what it adds, changes and removes against the project\'s architecture',
    scenario: 'architecture',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-hooks/architecture?view=api`);
      await until(page, 'the components drawn', COMPONENTS);
      assert.equal(await page.eval(() => document.querySelector('[data-changes-toggle]')?.parentElement?.textContent), 'This task\'s changes (6)');
      const unmarked = await page.eval(colors);
      assert.notEqual(unmarked['billing.api.retries'], 'green');
      await page.click('[data-changes-toggle]');
      await page.until('the toggle in the URL', () => location.search === '?view=api&changes');
      await page.until('the marks', () => {
        const root = [...document.querySelectorAll('[data-canvas] *')].find((e) => e.shadowRoot)?.shadowRoot;
        const color = (id: string) => root?.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"] [data-likec4-color]`)?.dataset.likec4Color;
        return color('billing.api.retries') === 'green' && color('billing.api.webhooks') === 'amber';
      });
      const marked = await page.eval(colors);
      assert.equal(marked['billing.api.invoices'], unmarked['billing.api.invoices'], 'an unchanged element keeps its colour');
      const list = await page.eval(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-change-list] [data-change-kind]')]
        .map((s) => [s.dataset.changeKind, [...s.querySelectorAll('li')].map((li) => li.textContent)])));
      assert.deepEqual(list, {
        added: ['Retry queue queue', 'Payments → Webhook sender: emits paid events', 'Retry queue → Webhook sender: retries after backoff', 'Webhook sender → Retry queue: queues failed deliveries'],
        changed: ['Webhook sender component · description'],
        removed: ['Payments → Webhook sender: reports paid invoices'],
      });
      await shot('architecture-changes');
      await page.goto(`${mock.url}/s/s-hooks/architecture?view=api&changes`);
      await page.until('the list after a reload', () => !!document.querySelector('[data-change-list]'));
      await page.click('[data-changes-toggle]');
      await page.until('the list gone', () => !document.querySelector('[data-change-list]') && location.search === '?view=api');
    },
  },
  {
    name: 'ARCH.5 Keep as the project\'s architecture asks first, naming the main checkout and the changes, then copies the task\'s model over it; the button goes, and the toast\'s Undo puts the earlier model back',
    scenario: 'architecture',
    async run({ page, mock, shot }) {
      await openArchitecture(page, mock, 's-hooks');
      await until(page, 'the context drawn', CONTEXT);
      const [before] = (await summary(mock, 's-hooks')).models;
      assert.notEqual(before.standing, before.stamp);
      await page.click('[data-keep]');
      const asked = await page.until('the question', () => {
        const d = document.querySelector<HTMLDialogElement>('dialog#keep-architecture');
        return d?.open ? d.innerText : null;
      });
      assert.match(asked, /Keep this as the project's architecture\?/);
      assert.match(asked, /~\/code\/billing-api\/\.pitwall\/architecture/);
      assert.match(asked, /1 element added, 1 changed; 3 relationships added, 1 removed/);
      await shot('architecture-keep');
      await page.key('Escape');
      await page.until('the question closed', () => !document.querySelector<HTMLDialogElement>('dialog#keep-architecture')?.open);
      assert.equal(await page.eval(() => location.pathname), '/s/s-hooks/architecture', 'Esc closes only the question');
      assert.equal((await summary(mock, 's-hooks')).models[0].standing, before.standing, 'nothing kept on Cancel');

      await page.click('[data-keep]');
      await page.until('the question again', () => !!document.querySelector<HTMLDialogElement>('dialog#keep-architecture')?.open);
      await page.click('dialog#keep-architecture [data-keep-confirm]');
      const [kept] = await logged(mock, 'the keep', (e) => e.path === '/api/sessions/s-hooks/keep-architecture');
      assert.deepEqual(kept.body, { model: '', stamp: before.stamp });
      await page.until('the button gone', () => !document.querySelector('[data-keep]'));
      assert.equal((await summary(mock, 's-hooks')).models[0].standing, before.stamp, 'the project\'s model is the task\'s now');
      assert.equal((await summary(mock, 's-invoice')).models[0].standing, before.stamp, 'and every task of the repository sees it');
      await page.until('the toast', () => [...document.querySelectorAll('[popover]')].some((t) => t.textContent?.includes("Kept as billing-api's architecture")));
      await page.click('[popover] button', 'Undo');
      await logged(mock, 'the undo', (e) => e.path === '/api/sessions/s-hooks/restore-architecture');
      await page.until('the button back', () => !!document.querySelector('[data-keep]'));
      assert.equal((await summary(mock, 's-hooks')).models[0].standing, before.standing, 'the earlier model is back');
    },
  },
  {
    name: 'ARCH.6 a model that does not parse shows LikeC4\'s errors with file, line and column instead of a canvas, and cannot be kept',
    scenario: 'architecture',
    async run({ page, mock, shot, themes }) {
      await openArchitecture(page, mock, 's-invoice');
      const errors = await page.until('the errors', () => {
        const items = [...document.querySelectorAll('[data-model-errors] li')].map((li) => li.textContent);
        return items.length ? items : null;
      });
      assert.deepEqual(errors, ['.pitwall/architecture/model.c4:54:2Missing \'}\' before the end of the file']);
      assert.equal(await page.eval(() => !!document.querySelector('[data-canvas]')), false);
      assert.equal(await page.eval(() => document.querySelector<HTMLButtonElement>('[data-keep]')?.disabled), true);
      assert.equal(await page.eval(() => !!document.querySelector('[data-changes-toggle]')), false);
      await themes(async () => shot('architecture-errors'));

      const { home } = await (await fetch(`${mock.url}/api/state`)).json();
      await fetch(`${mock.url}/mock/architecture`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: `${home}/code/worktrees/invoice-rounding/billing-api`, name: 'model.c4', text: STANDING_MODEL['model.c4'] }),
      });
      await until(page, 'the fixed model drawn', CONTEXT);
      assert.equal(await page.eval(() => !!document.querySelector('[data-model-errors]')), false);
    },
  },
  {
    name: 'ARCH.7 in a narrow window the Architecture tab draws the model and its changes list under the canvas, with nothing scrolling sideways',
    scenario: 'architecture',
    narrow: true,
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-hooks/architecture?view=api&changes`);
      await until(page, 'the components drawn', COMPONENTS);
      await page.until('the list', () => !!document.querySelector('[data-change-list]'));
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await shot('architecture-narrow');
    },
  },
  {
    name: 'ARCH.8 Regenerate architecture… in the ⋯ menu asks in a dialog with a checkbox per repository, all checked, each naming the main checkout whose model it replaces: the task\'s own repository, or each worktree a task across a folder of repos opened; with none checked it cannot go, Esc sends nothing, and it sends the ones checked',
    scenario: 'architecture',
    async run({ page, mock, shot, themes }) {
      await openSheetOf(page, mock, 's-cart');
      await page.click(MORE);
      const items = await page.until('the menu', menuItems);
      assert.deepEqual(items, ['Open in Ghostty', 'Open session in terminal', 'Open in Finder', 'Open in VS Code', 'Regenerate architecture…', 'Quit Claude', 'Archive', 'Clear task…'], 'offered with no model yet');
      await page.key('Escape');
      await page.until('the menu closed', () => !document.querySelector(':popover-open'));
      await openRegenerate(page);
      assert.deepEqual(await page.until('the repository', dialogRepos), [{ name: 'storefront', path: '~/code/storefront/.pitwall/architecture', checked: true, disabled: false }]);
      assert.match(await page.eval(() => document.querySelector<HTMLDialogElement>('dialog#regenerate-architecture')!.innerText), /there is no Undo/);
      await themes(async () => shot('regenerate-dialog'));
      await page.click('dialog#regenerate-architecture [data-regenerate-repo="storefront"] input');
      await page.until('Regenerate disabled with nothing checked', confirmDisabled);
      await closeDialog(page);
      assert.equal(await page.eval(() => location.pathname), '/s/s-cart/overview', 'Esc closes only the dialog');

      const id = await folderTask(mock);
      await openSheetOf(page, mock, id);
      await openRegenerate(page);
      const repos = await page.until('both repositories', dialogRepos, 2);
      assert.deepEqual(repos, [
        { name: 'storefront', path: '~/code/storefront/.pitwall/architecture', checked: true, disabled: false },
        { name: 'billing-api', path: '~/code/billing-api/.pitwall/architecture', checked: true, disabled: false },
      ]);
      await shot('regenerate-dialog-folder');
      assert.equal((await mock.log()).some((e) => e.action === 'regenerate-architecture'), false, 'nothing sent before Regenerate');
      await page.click('dialog#regenerate-architecture [data-regenerate-repo="storefront"] input');
      assert.equal(await page.eval(confirmDisabled), false);
      await page.click('dialog#regenerate-architecture [data-regenerate-confirm]');
      const [sent] = await regenerations(mock);
      assert.deepEqual([sent.sessionId, sent.body, sent.status], [id, { repos: ['billing-api'] }, 204]);
      await page.until('the dialog closed', () => !document.querySelector<HTMLDialogElement>('dialog#regenerate-architecture')?.open);
    },
  },
  {
    name: 'ARCH.9 while a regeneration runs a spinner turns on the ⋯ button and the menu item, the dialog shows the repository as being regenerated, and a second run for that main checkout is refused; once done, a task whose copy was the replaced model draws the new one, and a task with its own changes keeps them',
    scenario: 'architecture',
    async run({ page, mock, shot }) {
      await openArchitecture(page, mock, 's-stripe');
      await until(page, 'the copy of the project\'s model drawn', CONTEXT);
      const [hooks] = (await summary(mock, 's-hooks')).models;
      await mock.post('/mock/regenerate-hold');
      await openRegenerate(page);
      assert.deepEqual(await page.until('the repository', dialogRepos), [{ name: 'billing-api', path: '~/code/billing-api/.pitwall/architecture', checked: true, disabled: false }]);
      await page.click('dialog#regenerate-architecture [data-regenerate-confirm]');
      const [sent] = await regenerations(mock);
      assert.deepEqual([sent.body, sent.status], [{ repos: [''] }, 204]);

      const spinning = (selector: string) => {
        const mark = document.querySelector(selector);
        return !!mark && getComputedStyle(mark).animationName !== 'none';
      };
      await page.until('the spinner on ⋯', spinning, `${MORE} [data-regenerating]`);
      await page.click(MORE);
      await page.until('the spinner on the menu item', spinning, ':popover-open button[data-regeneration="running"] [data-regenerating]');
      assert.match(await page.eval(() => document.querySelector(':popover-open button[data-regeneration="running"]')?.textContent ?? ''), /Opus is writing billing-api's model in its main checkout/);
      await shot('regenerate-running');
      await page.click(':popover-open button', 'Regenerate architecture…');
      assert.deepEqual(await page.until('the repository being regenerated', dialogRepos), [{ name: 'billing-api', path: '~/code/billing-api/.pitwall/architecture', checked: false, disabled: true }]);
      assert.equal(await page.eval(() => document.querySelector('[data-regenerating-note]')?.textContent), 'Being regenerated now');
      assert.equal(await page.eval(confirmDisabled), true);
      await closeDialog(page);

      const refused = await fetch(`${mock.url}/api/sessions/s-hooks/regenerate-architecture`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repos: [''] }),
      });
      assert.equal(refused.status, 400);
      assert.match((await refused.json()).error, /billing-api's architecture is being regenerated already/);

      await mock.post('/mock/regenerate-release');
      await until(page, 'the regenerated model drawn', REGENERATED_CONTEXT);
      assert.equal(await page.eval(() => document.querySelector<HTMLSelectElement>('[data-diagram-picker]')?.selectedOptions[0]?.textContent), 'Billing in context, as on develop');
      await page.until('the spinner gone', () => !document.querySelector('[data-regeneration]'));
      const [after] = (await summary(mock, 's-hooks')).models;
      assert.equal(after.stamp, hooks.stamp, 'the task\'s own changes stay');
      assert.notEqual(after.standing, hooks.standing, 'against the new project model');
      assert.equal((await summary(mock, 's-stripe')).models[0].stamp, after.standing, 'the untouched copy is the new model');
    },
  },
  {
    name: 'ARCH.10 a regeneration that fails shows only an icon on the ⋯ button, on the Wall too, and on the menu item, whose tooltip names the run\'s log; the next run clears it',
    scenario: 'architecture',
    async run({ page, mock, shot, themes }) {
      await openSheetOf(page, mock, 's-hooks');
      await mock.post('/mock/regenerate-fail', { error: 'claude -p exited 1: mock failure' });
      await openRegenerate(page);
      await page.click('dialog#regenerate-architecture [data-regenerate-confirm]');
      await regenerations(mock);
      await page.until('the icon on ⋯', () => !!document.querySelector('#task-sheet header button[aria-label="Session actions"] [data-regeneration-failed]'));
      const log = '~/Library/Application Support/pitwall/sessions/s-hooks/architecture/billing-api.log';
      const explain = await page.eval(() => document.querySelector('#task-sheet header button[aria-label="Session actions"]')?.getAttribute('data-explain') ?? '');
      assert.ok(explain.includes(log), explain);
      const home = await mock.home();
      assert.match(readFileSync(join(home, log.slice(2)), 'utf8'), /Failed: claude -p exited 1: mock failure\n$/);

      await page.click(MORE);
      await page.until('the menu in place', settled);
      await page.hover(':popover-open button[data-regeneration="failed"] [data-regeneration-failed]');
      const tip = await page.until('the tooltip', () => document.querySelector('#tooltip:popover-open')?.textContent ?? null);
      assert.ok(tip.includes(log), tip);
      await themes(async () => shot('regenerate-failed'));

      await page.goto(`${mock.url}/`);
      await page.until('the icon on the tile', () => !!document.querySelector('[data-tile][data-session="s-hooks"] button[aria-label="Session actions"] [data-regeneration-failed]'));

      await openSheetOf(page, mock, 's-hooks');
      await openRegenerate(page);
      await page.click('dialog#regenerate-architecture [data-regenerate-confirm]');
      await page.until('the icon gone once the next run is done', () => !document.querySelector('[data-regeneration]'));
      assert.match(readFileSync(join(home, log.slice(2)), 'utf8'), /Done\. Worktrees given the new model: [^\n]*stripe-18\/billing-api\n$/);
    },
  },
  {
    name: 'ARCH.11 in a narrow window the Regenerate architecture dialog of a task across a folder of repos fits, with nothing scrolling sideways',
    scenario: 'architecture',
    narrow: true,
    async run({ page, mock, shot }) {
      const id = await folderTask(mock);
      await openSheetOf(page, mock, id);
      await openRegenerate(page);
      await page.until('both repositories', dialogRepos, 2);
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      const fits = await page.eval(() => {
        const r = document.querySelector('dialog#regenerate-architecture')!.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth;
      });
      assert.ok(fits, 'the dialog is inside the window');
      await shot('regenerate-dialog-narrow');
    },
  },
];
