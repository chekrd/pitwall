import { record } from './recorder.ts';

// How the board is used, to tell what to improve: which screens, keys and controls, what a key press that did nothing
// was, which sections were in view before each action, sends and their Undo, cards shown, dialogs, slow responses and
// errors, each with how busy the board was. Never what is typed or what a task says: see controlName, and the server
// drops content fields besides. It stays on this Mac, in state.db's ux_events; `pnpm ux` reports it.

type Data = Record<string, unknown>;

interface UxEvent {
  at: number;
  name: string;
  data?: Data;
}

const page = typeof crypto !== 'undefined' ? crypto.randomUUID() : 'test';
let queued: UxEvent[] = [];

// How busy the board is, which each event carries, and the task names to keep out of what it records.
let board = { tasks: 0, deck: 0 };
let names: string[] = [];

export function setBoard(next: { tasks: number; deck: number; names: string[] }) {
  board = { tasks: next.tasks, deck: next.deck };
  names = [...new Set(next.names)].filter((n) => n.length >= 3 && !COMMON.has(n));
}

const COMMON = new Set(['main', 'master', 'develop', 'trunk', 'HEAD']);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole names only, so a branch called `fix` leaves `prefix` alone.
export const redact = (text: string, known = names) =>
  known.toSorted((a, b) => b.length - a.length).reduce((t, n) => t.replace(new RegExp(`(?<![\\w-])${escape(n)}(?![\\w-])`, 'g'), 'task'), text);

const ACTIONS = new Set(['click', 'key', 'send']);

export function track(name: string, data?: Data) {
  record('ux', { name, ...data });
  if (ACTIONS.has(name)) readBefore(name, data);
  const event: UxEvent = { at: Date.now(), name, data: { ...data, board } };
  queued.push(event);
  if (queued.length >= 50) flush();
  return event;
}

// The keepalive budget is shared with the sends that go out as the page goes away, so only a small batch takes it.
function flush({ leaving = false } = {}) {
  if (!queued.length || typeof fetch === 'undefined') return;
  const body = JSON.stringify({ page, events: queued });
  queued = [];
  fetch('/api/ux', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: leaving && body.length < 4000 }).catch(() => {});
}

// What a control says can be content (a task, finding, file or branch), so a control is named by its `data-ux` when
// it has one, else by its label or its text without the parts marked as content, and whatever names, paths and ids
// remain read as `task`, `path` and `#`.
const CONTENT = '[data-ux-content], code, pre';

function ownText(el: Element): string {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    else if (node instanceof Element && !node.matches(CONTENT)) text += ` ${ownText(node)} `;
  }
  return text;
}

export const scrubName = (text: string, known = names) =>
  redact(text.replace(/\s+/g, ' ').trim(), known)
    .replace(/~\/[\w.@-]*(?:\/[\w.@-]*)*|(?:\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]*)+/g, 'path')
    .replace(/\b[A-Z][A-Z\d]+-\d+\b/g, 'ticket')
    .replace(/\b(?=[\w-]*\d)[0-9a-f]{4,}(?:-[0-9a-f]{4,})+\b|\b(?=[a-f]*\d)[0-9a-f]{7,}\b/gi, '#')
    .replace(/\d+/g, '#');

export function controlName(el: Element) {
  if (el.closest('[data-option]')) return 'option';
  const named = el.getAttribute('data-ux') ?? el.getAttribute('aria-label') ?? el.getAttribute('data-explain') ?? ownText(el);
  const name = scrubName(named);
  return name ? name.slice(0, 40) : el.tagName.toLowerCase();
}

export const screenOf = (pathname: string) => {
  const task = /^\/s\/[^/]+(?:\/([^/]+))?/.exec(pathname);
  if (task) return `task/${task[1] ?? 'overview'}`;
  return pathname === '/wall' ? 'wall' : 'queue';
};

function areaOf(el: Element) {
  if (el.closest('[data-toast]')) return 'toast';
  const dialog = el.closest('dialog[id]');
  const base = dialog?.id === 'task-sheet' ? screenOf(location.pathname)
    : dialog ? dialog.id
      : el.closest('[popover]') ? 'popover'
        : el.closest('.views') ? (document.documentElement.dataset.view ?? 'view') : 'topbar';
  const kind = el.closest<HTMLElement>('[data-kind]')?.dataset.kind;
  return kind ? `${base}/${kind}` : base;
}

const CONTROL = 'button, a[href], summary, select, [role="tab"], [role="option"], [role="menuitem"], input[type="checkbox"], input[type="radio"]';

// Time on each screen, and on each section marked `data-ux-section` while at least half of it, or of the window, is in
// view, counted only while the page is in sight and someone used it in the last IDLE_MS, so a board left open over a
// weekend does not count as read. Each action takes the sections read since the one before it.
const IDLE_MS = 5 * 60_000;
let screen = '';
let seen = 0;
let lastTick = Date.now();
let lastInput = Date.now();
const inView = new Set<string>();
let reading = new Map<string, number>();

function tick() {
  const now = Date.now();
  const dt = now - lastTick;
  lastTick = now;
  if (document.visibilityState !== 'visible' || now - lastInput > IDLE_MS) return;
  seen += dt;
  for (const section of inView) reading.set(section, (reading.get(section) ?? 0) + dt);
}

function readBefore(action: string, data?: Data) {
  if (typeof document === 'undefined') return;
  tick();
  const sections = Object.fromEntries([...reading].filter(([, ms]) => ms >= 500).map(([k, ms]) => [k, ms]));
  reading = new Map();
  if (!Object.keys(sections).length) return;
  const what = data?.control ?? data?.action ?? null;
  queued.push({ at: Date.now(), name: 'read', data: { screen, action, control: what, sections, board } });
}

function leave() {
  tick();
  if (screen && seen) track('screen', { screen, ms: seen });
  seen = 0;
}

function enter(next: string) {
  if (next === screen) return;
  leave();
  screen = next;
  reading = new Map();
}

function watchSections() {
  const fraction = (e: IntersectionObserverEntry) => Math.max(e.intersectionRatio, e.intersectionRect.height / innerHeight);
  const observer = new IntersectionObserver((entries) => {
    tick();
    for (const e of entries) {
      const name = (e.target as HTMLElement).dataset.uxSection!;
      if (e.isIntersecting && fraction(e) >= 0.5) inView.add(name);
      else inView.delete(name);
    }
  }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
  const observed = new Set<Element>();
  const scan = () => {
    for (const el of document.querySelectorAll('[data-ux-section]')) {
      if (!observed.has(el)) {
        observed.add(el);
        observer.observe(el);
      }
    }
    for (const el of observed) {
      if (el.isConnected) continue;
      observed.delete(el);
      observer.unobserve(el);
      if (![...observed].some((o) => (o as HTMLElement).dataset.uxSection === (el as HTMLElement).dataset.uxSection)) inView.delete((el as HTMLElement).dataset.uxSection!);
    }
  };
  new MutationObserver(scan).observe(document.body, { subtree: true, childList: true });
  scan();
}

const markInput = () => {
  tick();
  lastInput = Date.now();
};

if (typeof window !== 'undefined') {
  track('load', { width: innerWidth, height: innerHeight, screen: screenOf(location.pathname) });
  enter(screenOf(location.pathname));
  navigation.addEventListener('currententrychange', () => enter(screenOf(location.pathname)));
  for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll', 'focusin']) addEventListener(type, markInput, { capture: true, passive: true });
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      lastTick = Date.now();
      lastInput = Date.now();
      return;
    }
    leave();
    flush();
  });
  addEventListener('pagehide', () => {
    leave();
    flush({ leaving: true });
  });
  addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest(CONTROL) : null;
    if (!el) return;
    track('click', { control: controlName(el), area: areaOf(el), via: e.detail === 0 ? 'keyboard' : 'pointer' });
  }, true);
  setInterval(flush, 15_000);

  const opened = new Map<Element, number>();
  const watchDialogs = () => new MutationObserver((records) => {
    for (const r of records) {
      const d = r.target as HTMLDialogElement;
      if (!(d instanceof HTMLDialogElement) || !d.id) continue;
      if (d.open && !opened.has(d)) {
        opened.set(d, Date.now());
        track('dialog-open', { dialog: d.id, screen });
      } else if (!d.open && opened.has(d)) {
        track('dialog-close', { dialog: d.id, ms: Date.now() - opened.get(d)! });
        opened.delete(d);
      }
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  const watch = () => {
    watchDialogs();
    watchSections();
  };
  if (document.body) watch();
  else addEventListener('DOMContentLoaded', watch);

  // Slow responses to a click or key (INP's measure: input to the next paint) and the main thread held up.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[]) {
        if (e.duration < 200 || !e.interactionId) continue;
        const el = e.target instanceof Element ? (e.target.closest(CONTROL) ?? e.target) : null;
        track('slow', { event: e.name, ms: Math.round(e.duration), control: el ? controlName(el) : null, screen });
      }
    }).observe({ type: 'event', durationThreshold: 200, buffered: true } as PerformanceObserverInit);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration >= 200) track('freeze', { ms: Math.round(e.duration), screen });
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // A browser without these entry types records neither.
  }
  // A request the server could not take, as while it restarts, is no crash: the link reconnects and the page goes on.
  const crash = (error: unknown, where: string | null) => {
    if (error instanceof TypeError && ((error as { code?: string }).code === 'unreachable' || error.message === 'Failed to fetch')) return void track('unreachable', { where, screen });
    track('crash', { error: scrubName(String(error instanceof Error ? `${error.name}: ${error.message}` : error)).slice(0, 160), where, screen });
  };
  addEventListener('error', (e) => crash(e.error ?? e.message, e.filename ? `${e.filename.split('/').at(-1)}:${e.lineno}` : null));
  addEventListener('unhandledrejection', (e) => crash(e.reason, null));
}
