import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { until, type Look, type Page } from './cdp.ts';
import { startMock, type Entry, type Mock } from './mock.ts';

// The build under test, which the runner names with --dist.
const underTest = () => process.env.PITWALL_E2E_DIST ?? join(import.meta.dirname, '..', '..', 'web', 'dist');

export interface Context {
  page: Page;
  mock: Mock;
  look: Look;
  // Saves a screenshot when the run collects them (--shots), in both colour schemes unless the run has a look per scheme.
  shot: (name: string) => Promise<void>;
  // Runs `fn` in the look's colour scheme and, unless the run has a look per scheme, again with the system switched to
  // the other one, then switches back.
  themes: (fn: (scheme: Look['scheme']) => Promise<void>) => Promise<void>;
  // Waits `ms` on the page's clock: real time, or a share of it under a fast clock.
  wait: (ms: number) => Promise<void>;
}

export interface Check {
  name: string;
  // Runs in the narrow window (390×844) instead of the wide ones.
  narrow?: boolean;
  // Runs with this motion preference in every look.
  motion?: Look['motion'];
  scenario?: string;
  // Console errors the check provokes on purpose.
  expectedErrors?: RegExp[];
  // The page's timers and dates run faster (FAST_CLOCK times), so the 5 s hold, the 0.9 s guard and the like pass
  // quickly. The check waits with wait(), not sleep(), for anything timed by the page.
  clock?: 'fast';
  // New task as it first opens: More folded on Current checkout. Every other check starts with More open on New
  // worktree, as a stored choice would have it.
  newTask?: 'default';
  run: (t: Context) => Promise<void>;
}

export const NEW_TASK_MORE = `try { localStorage.getItem('pitwall:new-task-choices') || localStorage.setItem('pitwall:new-task-choices', '{"existing":false,"more":true}'); } catch {}`;

export const logged = (mock: Mock, what: string, match: (e: Entry) => boolean, timeout = 5000) =>
  until(`${what} in the mock's log`, async () => {
    const found = (await mock.log()).filter((e) => match(e) && e.status !== null);
    return found.length ? found : null;
  }, timeout);

// A mock of its own over a copy of the build. `build()` writes a new build there, an index.html that names a copy of
// the entry script, and returns that script. The page leaves before that mock stops, or its reconnect logs an error.
export async function withOwnBuild(page: Page, run: (own: Mock, build: () => string) => Promise<void>) {
  const dist = mkdtempSync(join(tmpdir(), 'pitwall-dist-'));
  let own: Mock | undefined;
  try {
    cpSync(underTest(), dist, { recursive: true });
    own = await startMock({ dist });
    await run(own, () => {
      const html = readFileSync(join(dist, 'index.html'), 'utf8');
      const entry = html.match(/src="([^"]+\.js)"/)![1];
      const next = entry.replace(/\.js$/, '-next.js');
      copyFileSync(join(dist, entry), join(dist, next));
      writeFileSync(join(dist, 'index.html'), html.replace(entry, next));
      return next;
    });
  } finally {
    await page.goto('about:blank').catch(() => {});
    await own?.stop();
    rmSync(dist, { recursive: true, force: true });
  }
}

// Every load and reload of the page requests its document again.
export const loads = (page: Page, url: string) => page.requests.filter((u) => u === url).length;

// Page functions: they run in the browser, so they use only their arguments.

// The connection pill: its state, its text, and whether its dot is green (live) or warm (reconnecting).
export const connection = () => {
  const pill = document.querySelector<HTMLElement>('[data-link]');
  const dot = pill?.firstElementChild;
  const [r, g] = (dot ? getComputedStyle(dot).backgroundColor.match(/\d+/g) ?? [] : []).map(Number);
  return { link: pill?.dataset.link ?? null, text: pill?.innerText.trim() ?? null, warm: r > g, green: g > r };
};

// What scrolls sideways, but for code and the agents dock, which does so by design in a narrow window.
export const sidewaysScroll = () => {
  const wide = (el: Element) => el.scrollWidth > el.clientWidth + 1;
  const out = wide(document.scrollingElement!) ? ['the page'] : [];
  for (const el of document.querySelectorAll('body *')) {
    const { overflowX } = getComputedStyle(el);
    if ((overflowX === 'auto' || overflowX === 'scroll') && wide(el) && !el.closest('pre, code, textarea, [data-dock]')) {
      out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`);
    }
  }
  return out;
};

export const reachable = (selector: string, text: string) => {
  const el = [...document.querySelectorAll(selector)].find((e) => (e.textContent ?? '').includes(text));
  if (!el) return false;
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  // Layout positions are fractional and scroll offsets whole pixels, so an element scrolled into view can stick out by less than one.
  return r.width > 0 && r.left > -1 && r.top > -1 && r.right < innerWidth + 1 && r.bottom < innerHeight + 1;
};

export const edgeLine = (end: 'top' | 'bottom', line: number) => {
  const list = document.querySelector('section[data-file]')?.parentElement;
  if (!list) return false;
  list.scrollTop = end === 'top' ? 0 : list.scrollHeight;
  const pre = list.querySelector('diffs-container')?.shadowRoot?.querySelector('pre');
  const numbers = [...(pre?.querySelectorAll('[data-column-number]') ?? [])].map((l) => Number(l.getAttribute('data-column-number')));
  return numbers.length > 0 && (end === 'top' ? Math.min(...numbers) : Math.max(...numbers)) === line;
};

export const luminance = (rgb: string) => {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).map((c) => Number(c) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// What a check leaves on the page's window: a marker a reload would drop, and the messages of a socket of its own.
export interface Probe {
  e2eMarker?: boolean;
  e2eMessages: { uiEntry?: string | null; sessions: { title: string | null }[] }[];
}

// The first message the check's socket got, or the first that shows `title`.
export const received = (title: string | null) => {
  const m = (window as unknown as Probe).e2eMessages?.find((m) => title === null || m.sessions.some((s) => s.title === title));
  return m && { carries: 'uiEntry' in m, uiEntry: m.uiEntry ?? null };
};

// Whether the check's socket got a message that shows `title` and names `entry`.
export const named = (entry: string, title: string) =>
  !!(window as unknown as Probe).e2eMessages?.some((m) => m.uiEntry === entry && m.sessions.some((s) => s.title === title));

export const navigation = () => ({
  marker: (window as unknown as Probe).e2eMarker ?? null,
  type: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type ?? null,
  entry: document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null,
});

// Sets the marker and opens the check's socket; returns the page's entry script.
export const listen = () => {
  const w = window as unknown as Probe;
  w.e2eMarker = true;
  w.e2eMessages = [];
  new WebSocket(`ws://${location.host}/ws/events`).onmessage = (e) => w.e2eMessages.push(JSON.parse(e.data));
  return document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null;
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.json': 'application/json',
};

// The build with no board behind it: the page loads, and its socket never opens, so no snapshot ever arrives.
export async function withoutBoard(run: (url: string) => Promise<void>) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://board').pathname;
    if (path === '/favicon.ico') return void res.writeHead(204).end();
    const root = underTest();
    const file = extname(path) ? join(root, path) : join(root, 'index.html');
    const body = file.startsWith(root) ? await readFile(file).catch(() => null) : null;
    res.writeHead(body ? 200 : 404, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
}

export const tiles = () => document.querySelectorAll('[data-tile]').length > 0;

export const sheetOpen = () => !!document.querySelector('#task-sheet');

// No transition is running, as when a sheet or dialog has finished sliding in.
// Transitions, and animations that end, such as a menu fading in; a spinner's endless one never settles.
export const settled = () => document.getAnimations().every((a) =>
  a.playState === 'finished' || !(a instanceof CSSTransition || (a instanceof CSSAnimation && a.effect?.getComputedTiming().iterations !== Infinity)));

export async function openFromWall(page: Page, mock: Mock, id: string) {
  await page.goto(`${mock.url}/wall`);
  await page.until('the tiles', tiles);
  await page.click(`[data-tile][data-session="${id}"] a`);
  await page.until(`the sheet of ${id}`, sheetOpen);
}

// A task's page loaded straight from its URL, over the queue.
export async function openSheetOf(page: Page, mock: Mock, id: string) {
  await page.goto(`${mock.url}/s/${id}/overview`);
  await page.until(`the sheet of ${id}`, sheetOpen);
}

// The labels of the open ⋯ menu.
export const clearDisabled = () => document.querySelector<HTMLButtonElement>('dialog#delete-worktree footer button:last-child')!.disabled;
export const approveLoss = (page: Page) => page.click('dialog#delete-worktree input[data-approve]');

export const menuItems = () => {
  const menu = document.querySelector(':popover-open');
  return menu && [...menu.querySelectorAll(':scope > button')].map((b) => b.firstElementChild?.textContent);
};

// A frame of the board's own page at another width, which draws what a window that wide would.
export const frame = (path: string, width: number, height: number) =>
  new Promise<void>((done) => {
    document.getElementById('e2e-frame')?.remove();
    const f = document.createElement('iframe');
    f.id = 'e2e-frame';
    f.src = path;
    f.style.cssText = `position: fixed; inset: 0 auto auto 0; width: ${width}px; height: ${height}px; border: 0; z-index: 9999; background: Canvas`;
    f.onload = () => done();
    document.body.append(f);
  });

// The meter in the page, or in the frame: whether it meets the wordmark or Repos, its segments' widths, its bars, the
// text it carries for screen readers and the text it shows.
export const meterIn = (inFrame: boolean) => {
  const doc = inFrame ? (document.getElementById('e2e-frame') as HTMLIFrameElement).contentDocument! : document;
  const box = (el: Element | null) => el?.getBoundingClientRect() ?? null;
  const meets = (a: DOMRect | null, b: DOMRect | null) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const wordmark = box(doc.querySelector('[data-wordmark]'));
  const repos = box(doc.querySelector('[data-repos]'));
  const parts = [box(doc.querySelector('[data-meter]')), box(doc.querySelector('[data-meter] [role="group"]'))];
  return {
    overlap: parts.some((m) => meets(m, wordmark) || meets(m, repos)),
    segments: [...doc.querySelectorAll('[data-segment]')].map((s) => Math.round(s.getBoundingClientRect().width * 10) / 10),
    bars: [...doc.querySelectorAll('[data-bar]')].map((b) => b.textContent),
    label: doc.querySelector('[data-meter] [role="group"]')?.getAttribute('aria-label') ?? null,
    shown: (doc.querySelector('[data-meter]') as HTMLElement | null)?.innerText.trim() ?? null,
    justIn: [...doc.querySelectorAll<HTMLElement>('[data-justin]')].map((j) => j.innerText.trim()),
  };
};

// The toasts of a kind: what each shows, whether it sits inside the open sheet, and whether a point in its middle hits
// it; null while there is none.
export const toastsOf = (kind: string) => {
  const shown = [...document.querySelectorAll<HTMLElement>(`[data-toast][data-kind="${kind}"]`)].map((t) => {
    const r = t.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { kind: t.dataset.kind, text: t.innerText.trim(), inSheet: !!t.closest('#task-sheet'), hit: !!hit && t.contains(hit) };
  });
  return shown.length ? shown : null;
};

// One file of the diff on its own, whole, with the way back to all files or its folder.
export const wholeFile = (path: string) =>
  document.querySelector('[data-theme="dark"] code')?.textContent === path && document.querySelectorAll('section[data-file]').length === 1 &&
  !!document.querySelector('[data-theme="dark"] > div button')?.textContent?.startsWith('← ');

// The connection pill once it reads `link` and, while reconnecting, says since when.
export const pillAt = (link: string) => {
  const p = document.querySelector<HTMLElement>('[data-link]');
  if (p?.dataset.link !== link || (link === 'reconnecting' && !p.dataset.explain)) return null;
  return { link: p.dataset.link, text: p.innerText.trim(), title: p.dataset.explain ?? "", breathing: getComputedStyle(p.firstElementChild!).animationName };
};

// The reload pill and what the page has: the marker a reload would drop, the link, and the New task prompt. With
// `until` set, null until the pill shows or the board reconnects.
export const reloadState = (until: 'pill' | 'reconnecting' | null) => {
  const state = {
    pill: document.querySelector<HTMLElement>('[data-new-version]')?.innerText.trim() ?? null,
    link: document.querySelector<HTMLElement>('[data-link]')?.dataset.link ?? null,
    marker: (window as unknown as Probe).e2eMarker ?? null,
    prompt: document.querySelector<HTMLTextAreaElement>('dialog#new-task textarea')?.value ?? null,
    typing: document.activeElement === document.querySelector('dialog#new-task textarea'),
  };
  return (until === 'pill' && !state.pill) || (until === 'reconnecting' && state.link !== 'reconnecting') ? null : state;
};

// The queue's card: whose it is, its kind and key, its name for screen readers, the text of its header and of the
// whole card, and what its primary says and whether the guard holds it.
export const card = () => {
  const c = document.querySelector<HTMLElement>('[data-card]');
  if (!c) return null;
  const primary = c.querySelector<HTMLElement>('[data-primary]');
  return {
    session: c.dataset.session ?? null,
    kind: c.dataset.kind ?? null,
    key: c.dataset.key ?? null,
    label: c.getAttribute('aria-label'),
    header: c.querySelector('header')?.innerText ?? '',
    text: c.innerText,
    primary: primary?.firstElementChild?.textContent ?? null,
    disabled: primary?.matches(':disabled') ?? null,
    guarded: primary?.hasAttribute('data-guarded') ?? null,
  };
};

// `id` is the card and no deal is moving it.
export const frontIs = (id: string) => document.querySelector<HTMLElement>('[data-card]')?.dataset.session === id && !document.documentElement.dataset.deal;

// No card is being dealt, and every animation that ends has ended.
export const still = () => !document.documentElement.dataset.deal &&
  document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity);

// The element shows whole: inside the window and inside every box around it that clips.
export const whole = (selector: string) => {
  const el = document.querySelector(selector);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || r.top < -1 || r.left < -1 || r.bottom > innerHeight + 1 || r.right > innerWidth + 1) return false;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(p);
    if (overflowX === 'visible' && overflowY === 'visible') continue;
    const b = p.getBoundingClientRect();
    if (r.top < b.top - 1 || r.bottom > b.bottom + 1 || r.left < b.left - 1 || r.right > b.right + 1) return false;
  }
  return true;
};

// The element starts in view in the card's scroll area, which scrolls to the rest of it.
export const startsInScroll = (selector: string) => {
  const el = document.querySelector(selector);
  const scroll = el?.closest('[data-scroll]');
  if (!el || !scroll || scroll.scrollHeight <= scroll.clientHeight) return false;
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + Math.min(24, r.width / 2), r.top + Math.min(12, r.height / 2));
  return !!hit && el.contains(hit);
};

// The peeks behind the card, each with its place, session and text.
// The branch mark before the name is left out of `text`.
export const peeks = () => [...document.querySelectorAll<HTMLElement>('[data-peek]')].map((p) => {
  const branch = p.querySelector<HTMLElement>('[data-branch]')?.innerText;
  const text = p.innerText.trim();
  return { peek: p.dataset.peek, session: p.dataset.session, branch, text: branch && text.startsWith(branch) ? text.slice(branch.length).trim() : text };
});

export const segmentsNow = () => [...document.querySelectorAll<HTMLElement>('[data-segment]')].map((s) => ({
  session: s.dataset.session, current: s.hasAttribute('data-current'), new: s.hasAttribute('data-new'), width: Math.round(s.getBoundingClientRect().width),
}));

export const newTaskOnRepo = () => !!document.querySelector<HTMLDialogElement>('dialog#new-task')?.open &&
  document.activeElement === document.querySelector('dialog#new-task button[aria-haspopup="listbox"]');

// New task from the top bar, which opens on the repository, then its prompt clicked.
export async function openNewTask(page: Page) {
  await page.click('header button[aria-label="New task"]');
  await page.until('the New task dialog, its repository focused', newTaskOnRepo);
  await typeInPrompt(page);
}

export async function typeInPrompt(page: Page) {
  await page.click('dialog#new-task textarea');
  await page.until('the prompt focused', () => document.activeElement === document.querySelector('dialog#new-task textarea'));
}

export const pickerOpen = () => !!document.querySelector('#new-task [data-repo-picker]:popover-open');

// Opens New task's repository picker, types `filter` and picks the first match with Enter.
export async function pickRepo(page: Page, filter: string) {
  await page.click('dialog#new-task button[aria-haspopup="listbox"]');
  await page.until('the picker, its filter focused', () => !!document.querySelector('#new-task [data-repo-picker]:popover-open') &&
    document.activeElement === document.querySelector('#new-task [data-repo-picker] input'));
  await page.type(filter);
  await page.key('Enter');
  await page.until('the picker to close', () => !document.querySelector('#new-task [data-repo-picker]:popover-open'));
}

export async function openQueue(page: Page, mock: Mock, front = 's-cart') {
  await page.goto(`${mock.url}/`);
  await page.until(`the card of ${front}`, frontIs, front);
}

// A held send goes out 5 s after the press.
export const HELD_MS = 5500;
export const POSTED_MS = 8000;

// The session actions the mock has answered, the page's reads left out.
export const actions = async (mock: Mock) => (await mock.log()).filter((e) => e.method === 'POST' && e.action !== null && e.status !== null);

export const stateOf = async (mock: Mock, id: string) => (await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === id);

// A send the page has posted and the mock answered.
export const sent = (e: Entry) => e.method === 'POST' && e.action !== null;

export const unguarded = () => !document.querySelector('[data-card] footer[data-guarding]');

// `id` is the card, and the guard that came with it is over, so an answer key counts.
export async function ready(page: Page, id: string) {
  await page.until(`the card of ${id}`, frontIs, id);
  await page.until('the guard to end', unguarded);
}

// Records every deal the page runs from now on.
export const watchDeals = () => {
  const w = window as unknown as { e2eDeals: string[] };
  w.e2eDeals = [];
  let last: string | undefined;
  new MutationObserver(() => {
    const deal = document.documentElement.dataset.deal;
    if (deal && deal !== last) w.e2eDeals.push(deal);
    last = deal;
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-deal'] });
};
export const dealt = () => (window as unknown as { e2eDeals?: string[] }).e2eDeals ?? [];

// Writes `text` in s-cart's reply box and sends it with Enter, which deals the card and brings up s-hooks.
export async function replyOnCart(page: Page, mock: Mock, text: string) {
  await openQueue(page, mock);
  await ready(page, 's-cart');
  await page.key('w');
  await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
  await page.type(text);
  await page.key('Enter');
  await page.until('s-hooks at the front', frontIs, 's-hooks');
}

// A reply to s-cart the page never knew to have gone out comes back as Not sent, and Show brings up its card with the
// text in the reply box.
export async function cartNotSent(page: Page, text: string) {
  const [error] = await until('the Not sent toast', () => page.eval(toastsOf, 'error'), 15_000);
  assert.equal(error.text, 'Not sent to Merge guest cart on login: the page closed before it went out\nShow');
  await page.click('[data-toast] button', 'Show');
  await page.until('s-cart at the front', frontIs, 's-cart');
  assert.equal((await page.eval(replyIn, '[data-card]'))?.value, text);
}

// A one-pixel PNG on disk, for a file chooser, in a folder of its own that `remove` deletes.
export function pngOnDisk() {
  const dir = mkdtempSync(join(tmpdir(), 'pitwall-png-'));
  const file = join(dir, 'shot.png');
  writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

// Pastes a one-pixel PNG into the reply box, as a screenshot from the clipboard comes.
export const pastePng = (selector: string) => {
  const field = document.querySelector<HTMLTextAreaElement>(selector)!;
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const data = new DataTransfer();
  data.items.add(new File([png], 'shot.png', { type: 'image/png' }));
  field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
};

// The reply box in `scope`: its text, each attachment as "<state> <name>", and whether it has focus.
export const replyIn = (scope: string) => {
  const field = document.querySelector<HTMLTextAreaElement>(`${scope} textarea`);
  const box = field?.closest('section');
  return field && box ? {
    value: field.value,
    files: [...box.querySelectorAll<HTMLElement>('[data-state]')].map((f) => `${f.dataset.state} ${f.querySelector('button')?.getAttribute('aria-label')?.replace(/^Remove /, '')}`),
    focused: document.activeElement === field,
  } : null;
};

// Pressing a key on the card from a script, as auto-repeat or a fast double press would.
export const pressEnter = (gaps: number[], repeat = false) =>
  new Promise<void>((done) => {
    const press = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', repeat, bubbles: true, cancelable: true }));
    press();
    let at = 0;
    for (const gap of gaps) setTimeout(press, (at += gap));
    setTimeout(done, at + 50);
  });

// The agents dock as drawn: its label and count, the ended pill, the box of the capsules' grid and how far it scrolls,
// and each capsule with its state, name, second line (in a mono font or not), clock, PR dot (its animation), Worth-
// knowing dot and boxes; null while there is no dock.
export const dockState = () => {
  const dock = document.querySelector<HTMLElement>('[data-dock]');
  if (!dock) return null;
  const box = (el: Element | null | undefined) => {
    const r = el?.getBoundingClientRect();
    return r ? { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: r.width, height: r.height } : null;
  };
  const grid = dock.querySelector('[data-capsule]')?.parentElement;
  const ended = dock.querySelector<HTMLAnchorElement>('a[href="/wall"]');
  return {
    label: dock.getAttribute('aria-label'),
    count: (dock.firstElementChild as HTMLElement).innerText,
    ended: ended && { text: ended.innerText.trim(), title: ended.dataset.explain ?? "" },
    box: box(dock),
    grid: grid && { box: box(grid), scrollHeight: grid.scrollHeight, clientHeight: grid.clientHeight },
    capsules: [...dock.querySelectorAll<HTMLElement>('[data-capsule]')].map((c) => {
      const name = c.querySelector('button strong');
      const line = name?.parentElement?.nextElementSibling;
      const pr = c.querySelector('button [data-pr]');
      return {
        session: c.dataset.session!,
        state: c.dataset.state,
        name: name?.textContent,
        line: line?.textContent,
        mono: !!line && getComputedStyle(line).fontFamily.includes('monospace'),
        clock: c.querySelector('[data-clock]')?.textContent ?? null,
        pr: pr && getComputedStyle(pr).animationName,
        know: !!c.querySelector('button [data-know]'),
        box: box(c),
        nameBox: box(name),
        lineBox: box(line),
      };
    }),
  };
};

// A capsule's hover card while it is open: its popover type, what it says, its box and its capsule's.
export const hoverCard = (id: string) => {
  const capsule = document.querySelector(`[data-capsule][data-session="${id}"]`);
  const card = capsule?.querySelector<HTMLElement>('[data-hovercard]');
  if (!capsule || !card?.matches(':popover-open')) return null;
  const r = card.getBoundingClientRect();
  const c = capsule.querySelector('button')!.getBoundingClientRect();
  return {
    popover: card.popover,
    text: card.innerText,
    box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
    capsule: { left: c.left, right: c.right, top: c.top },
    inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
  };
};

// The sessions whose hover card is open.
export const openCards = () => [...document.querySelectorAll('[data-hovercard]:popover-open')].map((c) => c.closest<HTMLElement>('[data-capsule]')?.dataset.session);

export const docked = (n: number) => document.querySelectorAll('[data-dock] [data-capsule]').length === n;

// The card's primary shows whole in the window at the top of the page's scroll and at its bottom, and whether the page
// scrolls at all, which the second needs to mean anything.
export const primaryAtEnds = () => {
  const page = document.scrollingElement!;
  const inView = () => {
    const r = document.querySelector('[data-card] [data-primary], [data-card] footer textarea')!.getBoundingClientRect();
    return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  };
  page.scrollTop = 0;
  const top = inView();
  page.scrollTop = page.scrollHeight;
  const bottom = inView();
  const scrolls = page.scrollTop > 0;
  page.scrollTop = 0;
  return { top, bottom, scrolls };
};

// The card in a narrow window: whether its columns, or a menu's questions, stand one under the other, which peeks
// and slivers show, and how many rows the footer's buttons and reply box take.
export const narrowCard = () => {
  const c = document.querySelector('[data-card]')!;
  const stacked = (els: Element[]) => {
    const rs = els.map((e) => e.getBoundingClientRect());
    return rs.every((r, i) => i === 0 || (Math.abs(r.left - rs[0].left) < 1 && r.top >= rs[i - 1].bottom - 1));
  };
  const shown = (el: Element | null) => !!el?.checkVisibility();
  return {
    stacked: stacked([...c.querySelectorAll('[data-side]')]) && stacked([...c.querySelectorAll('section[role="group"]')]),
    peeks: [...document.querySelectorAll<HTMLElement>('[data-peek]')].filter(shown).map((p) => p.dataset.peek),
    sliver: shown(document.querySelector('[data-sliver]')),
    footRows: new Set([...c.querySelectorAll('footer button, footer textarea')].filter(shown).map((b) => { const r = b.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })).size,
  };
};

// Starts noting every animation the page runs, with when it ends after it starts; `animations()` stops and returns them.
export const noteAnimations = () => {
  const w = window as unknown as { e2eAnimations: Map<Animation, string>; e2eNoting: boolean };
  w.e2eAnimations = new Map();
  w.e2eNoting = true;
  const tick = () => {
    for (const a of document.getAnimations()) {
      const name = a instanceof CSSAnimation ? a.animationName : a instanceof CSSTransition ? `transition of ${a.transitionProperty}` : 'animation';
      const target = (a.effect as KeyframeEffect | null)?.target;
      const where = target ? `${target.tagName.toLowerCase()}${(a.effect as KeyframeEffect).pseudoElement ?? ''}` : '';
      w.e2eAnimations.set(a, `${name} on ${where}: ${Math.round(Number(a.effect?.getComputedTiming().endTime) * 100) / 100} ms`);
    }
    if (w.e2eNoting) requestAnimationFrame(tick);
  };
  tick();
};
export const animations = () => {
  const w = window as unknown as { e2eAnimations: Map<Animation, string>; e2eNoting: boolean };
  w.e2eNoting = false;
  return [...w.e2eAnimations.entries()].map(([a, text]) => ({ text, end: Number(a.effect?.getComputedTiming().endTime) }));
};

// Text drawn at less than `min`:1 against what it is drawn on. The text's colour and the backgrounds of its element and
// of those around it are composited in order, up to the dialog or popover it sits in, and each element's opacity
// applies to all it draws; a gradient counts at each of its stops. A field counts with its value or its placeholder.
// Left out: disabled controls, the primary while its guard ignores presses, text nobody can see, the page under a
// modal dialog's scrim, and the diff's code, the user's Darcula in shadow roots this does not walk.
export const lowContrast = (min: number) => {
  type C = [number, number, number, number];
  const unread = new Set<string>();
  const parse = (s: string): C => {
    const rgb = s.match(/^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
    const srgb = s.match(/^color\(srgb ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)(?: \/ ([-\d.e]+))?\)$/);
    if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
    unread.add(s);
    return [0, 0, 0, 0];
  };
  const channel = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const lum = (c: C) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
  const ratio = (a: C, b: C) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const over = (c: C, under: C): C => [c[0] * c[3] + under[0] * (1 - c[3]), c[1] * c[3] + under[1] * (1 - c[3]), c[2] * c[3] + under[2] * (1 - c[3]), 1];
  const mix = (a: C, b: C, t: number): C => [a[0] * t + b[0] * (1 - t), a[1] * t + b[1] * (1 - t), a[2] * t + b[2] * (1 - t), 1];
  const ground = parse(getComputedStyle(document.body).backgroundColor);
  // Every pair of text and background colour the text can show in, from layer `i` in.
  const paint = (layers: Element[], i: number, under: C, text: C): { fg: C; bg: C }[] => {
    const style = getComputedStyle(layers[i]);
    const bg = over(parse(style.backgroundColor), under);
    const stops = (style.backgroundImage.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)/g) ?? []).map((s) => over(parse(s), bg));
    const inner = [bg, ...stops].flatMap((g) => (i === layers.length - 1 ? [{ fg: over(text, g), bg: g }] : paint(layers, i + 1, g, text)));
    const opacity = Number(style.opacity);
    return opacity >= 1 ? inner : inner.map(({ fg, bg: b }) => ({ fg: mix(fg, under, opacity), bg: mix(b, under, opacity) }));
  };
  const layersOf = (el: Element) => {
    const out: Element[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      out.unshift(e);
      if (e.matches(':modal, :popover-open')) break;
    }
    return out;
  };
  const named = (el: Element) => {
    const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
    return `${el.tagName.toLowerCase()}${cls ? `.${cls.slice(cls.indexOf('_', 1) + 1)}` : ''}`;
  };
  const fails = new Set<string>();
  const modal = !!document.querySelector('dialog:modal');
  const test = (el: Element, text: string, color: string) => {
    // The tooltip's backdrop is a blur of whatever is under it, which no colour stands for.
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || el.closest(':disabled, [aria-disabled="true"], [data-guarded], #tooltip')) return;
    if (modal && !el.closest('dialog:modal, :popover-open')) return;
    const worst = Math.min(...paint(layersOf(el), 0, ground, parse(color)).map(({ fg, bg }) => ratio(fg, bg)));
    if (worst < min) fails.add(`${worst.toFixed(2)}:1 "${text.trim().replace(/\s+/g, ' ').slice(0, 48)}" in ${named(el)} < ${el.parentElement ? named(el.parentElement) : ''}`);
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.textContent?.trim() && n.parentElement) test(n.parentElement, n.textContent, getComputedStyle(n.parentElement).color);
  }
  for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type="checkbox"], [type="radio"], [type="file"]), textarea')) {
    if (field.value) test(field, field.value, getComputedStyle(field).color);
    else if (field.placeholder) test(field, field.placeholder, getComputedStyle(field, '::placeholder').color);
  }
  return [...fails, ...[...unread].map((s) => `a colour the audit cannot read: ${s}`)];
};
