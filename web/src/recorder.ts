import { watchMutations } from './mutations.ts';

// What happened on the page in the last minutes, kept in memory for a bug report (B): focus, keys (a text key reads
// `char`), paste, input, reply boxes coming and going, routes, the board's own events, state changes, failed requests
// and errors. Nothing leaves the page until a bug report is filed.

type Entry = [ms: number, type: string, detail: unknown, active: string | null, windowFocused: boolean];

const MAX = 5000;
const entries: Entry[] = [];
export const started = Date.now();

const serials = new WeakMap<object, number>();
let serial = 0;

// An element as the report names it: a serial per element, so a box that remounted reads as another number.
export function describe(el: EventTarget | null | undefined): string | null {
  if (!el) return null;
  if (el === window) return 'window';
  if (el === document) return 'document';
  if (!(el instanceof Element)) return Object.prototype.toString.call(el);
  if (!serials.has(el)) serials.set(el, ++serial);
  const h = el as HTMLElement;
  const bits = [`${el.tagName.toLowerCase()}#${serials.get(el)}`];
  if (el.id) bits.push(`id=${el.id}`);
  for (const k of ['draft', 'session', 'card', 'tile', 'queued', 'kind'] as const) if (h.dataset?.[k] !== undefined) bits.push(`${k}=${h.dataset[k]}`);
  const label = el.getAttribute('aria-label');
  if (label) bits.push(`"${label.slice(0, 40)}"`);
  if (!el.isConnected) bits.push('detached');
  return bits.join(' ');
}

export function record(type: string, detail: unknown = null) {
  if (typeof document === 'undefined') return;
  entries.push([Math.round(performance.now()), type, detail, describe(document.activeElement), document.hasFocus()]);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
}

export const recorded = () => entries.slice();

const boxesIn = (n: Node) => (n instanceof HTMLTextAreaElement && n.dataset.draft ? [n] : n instanceof Element ? [...n.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]')] : []);
function message(e: unknown) {
  if (e instanceof Error) return `${e.name}: ${e.message}\n${e.stack ?? ''}`.slice(0, 2000);
  if (typeof e !== 'object' || e === null) return String(e).slice(0, 2000);
  try {
    return JSON.stringify(e).slice(0, 2000);
  } catch {
    return Object.prototype.toString.call(e);
  }
}

if (typeof window !== 'undefined') {
  const on = (target: EventTarget, type: string, fn: (e: any) => void) => target.addEventListener(type, fn, true);
  on(window, 'focus', (e: FocusEvent) => e.target === window && record('window-focus'));
  on(window, 'blur', (e: FocusEvent) => e.target === window && record('window-blur'));
  on(window, 'focusin', (e: FocusEvent) => record('focusin', { target: describe(e.target), from: describe(e.relatedTarget) }));
  on(window, 'focusout', (e: FocusEvent) => record('focusout', { target: describe(e.target), to: describe(e.relatedTarget) }));
  on(document, 'visibilitychange', () => record('visibility', document.visibilityState));
  on(window, 'pointerdown', (e: PointerEvent) => record('pointerdown', describe(e.target)));
  on(window, 'keydown', (e: KeyboardEvent) => {
    const mods = `${e.metaKey ? 'Meta+' : ''}${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}`;
    const key = mods || e.key.length > 1 ? `${mods}${e.key}` : 'char';
    record('keydown', { key, target: describe(e.target), composing: e.isComposing, repeat: e.repeat });
  });
  on(window, 'paste', (e: ClipboardEvent) => record('paste', {
    target: describe(e.target),
    types: [...(e.clipboardData?.types ?? [])],
    textLength: e.clipboardData?.getData('text/plain').length ?? null,
    files: e.clipboardData?.files.length ?? 0,
    trusted: e.isTrusted,
  }));
  addEventListener('paste', (e) => record('paste-done', { defaultPrevented: e.defaultPrevented }));
  on(window, 'beforeinput', (e: InputEvent) => record('beforeinput', { inputType: e.inputType, dataLength: e.data?.length ?? null, target: describe(e.target), trusted: e.isTrusted }));
  on(window, 'input', (e: InputEvent) => record('input', {
    inputType: e.inputType,
    target: describe(e.target),
    valueLength: e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement ? e.target.value.length : null,
  }));
  on(window, 'compositionstart', (e: CompositionEvent) => record('compositionstart', describe(e.target)));
  on(window, 'compositionend', (e: CompositionEvent) => record('compositionend', { target: describe(e.target), dataLength: e.data.length }));
  on(window, 'toggle', (e: ToggleEvent) => e.target instanceof Element && e.target.matches('dialog, [popover]') && record('toggle', { target: describe(e.target), state: e.newState }));
  on(window, 'pagehide', () => record('pagehide'));
  on(window, 'pageshow', () => record('pageshow'));
  on(window, 'error', (e: ErrorEvent | Event) => record('error', e instanceof ErrorEvent ? { message: message(e.error ?? e.message), at: `${e.filename}:${e.lineno}:${e.colno}` } : { target: describe(e.target) }));
  on(window, 'unhandledrejection', (e: PromiseRejectionEvent) => record('unhandled-rejection', message(e.reason)));
  for (const level of ['error', 'warn'] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      record(`console-${level}`, args.map(message).join(' ').slice(0, 2000));
      original.apply(console, args);
    };
  }
  navigation.addEventListener('currententrychange', () => record('route', location.pathname));

  let active: Element | null = null;
  const watch = () => {
    watchMutations((records) => {
      for (const r of records) {
        for (const n of r.removedNodes) for (const b of boxesIn(n)) record('box-removed', describe(b));
        for (const n of r.addedNodes) for (const b of boxesIn(n)) record('box-added', describe(b));
      }
      if (active && !active.isConnected) record('focused-element-removed', describe(active));
      active = document.activeElement;
    });
    on(window, 'focusin', () => {
      active = document.activeElement;
    });
  };
  if (document.body) watch();
  else addEventListener('DOMContentLoaded', watch);
  record('load', { at: new Date(started).toISOString(), build: document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null });
}

const onScreen = (el: Element) => !el.closest('[inert]') && el.checkVisibility();

// The page as it is at this moment: taken when the report opens, before its dialog takes focus.
export function snapshot() {
  const selection = document.getSelection();
  const root = document.documentElement;
  return {
    at: new Date().toISOString(),
    ms: Math.round(performance.now()),
    url: location.href,
    viewport: [innerWidth, innerHeight],
    windowFocused: document.hasFocus(),
    visibility: document.visibilityState,
    active: describe(document.activeElement),
    selection: selection ? { anchor: describe(selection.anchorNode?.parentElement), type: selection.type } : null,
    view: root.dataset.view ?? null,
    deal: root.dataset.deal ?? null,
    open: [...document.querySelectorAll('dialog[open], :popover-open')].map(describe),
    boxes: [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]')].map((b) => ({
      box: describe(b),
      onScreen: onScreen(b),
      focused: b === document.activeElement,
      value: b.value,
      selection: [b.selectionStart, b.selectionEnd],
    })),
    text: document.body.innerText.slice(0, 30_000),
  };
}
