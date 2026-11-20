import { useEffect, useEffectEvent } from 'react';
import { openBugReport } from './components/BugReportDialog.tsx';
import { diffNarrowed, stepFile, widenDiff } from './components/DiffView.tsx';
import { toggleKeys } from './components/KeysDialog.tsx';
import { openNewTask } from './components/NewTaskForm.tsx';
import { keyAction, KEYS_DIALOG, LOCK_MS, rowFor, SHEET_DIALOG, typingLock, type Action, type Decision, type KeyContext, type Key, type Target } from './keys.ts';
import { openPopovers } from './layers.ts';
import { record } from './recorder.ts';
import { closeSheet, openSheet, showTab, type Route } from './router.ts';
import { holding, undo } from './sends.ts';
import { guarded } from './useDecision.ts';
import { hideTooltip, tooltipShown } from './tooltip.ts';
import { track } from './ux.ts';

// The reply box's paperclip counts as part of its field: focus on it is still writing a reply.
const EDITABLE = 'textarea, select, [contenteditable]:not([contenteditable="false"]), input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"])';
const CONTROL = 'button, a[href], input, select, summary';

// An open picker puts focus on one of its options.
export const isEditable = (el: EventTarget | null) => el instanceof Element && !!el.closest(EDITABLE);

function target(el: EventTarget | null): Target {
  const at = el instanceof Element ? el : null;
  return {
    editable: isEditable(at),
    control: !!at?.closest(CONTROL),
    option: !!at?.closest('[data-option]'),
    resizer: !!at?.closest('[role="separator"]'),
  };
}

const actionName = (a: Action) => [a.type, 'tab' in a ? a.tab : 'to' in a ? a.to : 'what' in a ? a.what : null].filter(Boolean).join(':');

const scopeOf = (ctx: KeyContext) => (ctx.sheet ? `task/${ctx.sheet.tab}` : 'wall');

// Misses in a row less than a second apart count into the first, so typing that lands on the page reads as one
// burst, not as the text.
let lastMiss: { at: number; data: { more: number } } | null = null;

// What a key press meant to the board: the action, a board key that did nothing here, or a key it has no use for,
// which shows what someone expected a key to do.
function trackKey(ctx: KeyContext, e: Key & { repeat: boolean }, action: Action | null) {
  if (e.repeat) return;
  const kind = ctx.decision?.kind ?? null;
  const row = rowFor(ctx, e);
  if (action) return void track('key', { action: actionName(action), keys: row?.keys, screen: scopeOf(ctx), kind });
  if (row) return void track('key-noop', { keys: row.keys, screen: scopeOf(ctx), kind, guarded: !!row.guarded && ctx.guarded });
  if (e.key.length !== 1 || e.key === ' ' || ctx.target.editable || ctx.modal || ctx.popovers.includes('auto')) return;
  const now = Date.now();
  if (lastMiss && now - lastMiss.at < 1000) {
    lastMiss.at = now;
    lastMiss.data.more++;
    return;
  }
  const data = { key: e.key.toLowerCase(), screen: scopeOf(ctx), kind, more: 0 };
  track('key-miss', data);
  lastMiss = { at: now, data };
}

function dom(e: KeyboardEvent): Pick<KeyContext, 'target' | 'modal' | 'popovers' | 'tip'> {
  const modal = document.querySelector(`dialog:modal:not(#${SHEET_DIALOG})`);
  return {
    target: target(e.target),
    modal: modal ? (modal.id === KEYS_DIALOG ? 'keys' : 'other') : null,
    popovers: openPopovers(),
    tip: tooltipShown(),
  };
}

// The board's one keydown listener. `context` gives what the app knows (the open task, its decision, the guard); the DOM
// gives the rest. A field that unmounts while typed in leaves focus on the page, and the typing lock takes the keys
// that follow until the typing stops.
export function useKeys(context: () => Omit<KeyContext, 'target' | 'modal' | 'popovers' | 'tip'>, dispatch: (action: Action, e: KeyboardEvent) => void) {
  const press = useEffectEvent((e: KeyboardEvent) => {
    const ctx = { ...context(), ...dom(e) };
    const action = keyAction(ctx, e);
    trackKey(ctx, e, action);
    if (!action) return;
    e.preventDefault();
    if (e.key === 'Escape') hideTooltip();
    dispatch(action, e);
  });

  useEffect(() => {
    const lock = typingLock();
    let field: Element | null = null;
    let typedAt = 0;
    const onPage = () => !document.activeElement || document.activeElement === document.body;
    const lost = (typing: boolean) => {
      if (!field || field.isConnected) return;
      field = null;
      if (typing && onPage()) {
        record('typing-lock');
        lock.start();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      field = isEditable(e.target) ? (e.target as Element) : null;
    };
    // Chrome also fires focusout when a focused field is removed; for a browser that does not, the next key finds
    // the field gone.
    const onFocusOut = (e: FocusEvent) => {
      const left = e.target;
      if (left !== field) return;
      queueMicrotask(() => {
        if (!field || field !== left) return;
        if (field.isConnected) field = null;
        else lost(true);
      });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) {
        typedAt = Date.now();
        return;
      }
      lost(Date.now() - typedAt < LOCK_MS);
      if (lock.takes(e)) {
        e.preventDefault();
        return;
      }
      press(e);
    };
    const onPointerDown = () => lock.end();
    // A dialog fades out with focus still in it when there is nowhere to give it back to, and keys typed meanwhile
    // would land in a field that is going away.
    const onClose = (e: Event) => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && e.target instanceof Element && e.target.contains(el)) el.blur();
    };
    addEventListener('focusin', onFocusIn, true);
    addEventListener('focusout', onFocusOut, true);
    addEventListener('keydown', onKeyDown);
    addEventListener('pointerdown', onPointerDown, true);
    addEventListener('close', onClose, true);
    return () => {
      removeEventListener('focusin', onFocusIn, true);
      removeEventListener('focusout', onFocusOut, true);
      removeEventListener('keydown', onKeyDown);
      removeEventListener('pointerdown', onPointerDown, true);
      removeEventListener('close', onClose, true);
    };
  }, []);
}

// The decision a task's Overview shows, with what its keys do. Overview sets it while it shows one.
export interface Front {
  decision: Decision;
  act: (action: Action, e: KeyboardEvent) => void;
}

let front: Front | null = null;

export function useFront(value: Front | null) {
  useEffect(() => {
    front = value;
    return () => {
      if (front === value) front = null;
    };
  }, [value]);
}

// The board's keys: the next decision, New task, Bug report, the Keys dialog, Undo and the task's tabs and files here,
// and the decision's keys through the front Overview sets.
export function useBoardKeys({ route, next, repos, artifacts, documents, architecture }: { route: Route; next: string | null; repos: boolean; artifacts: boolean; documents: boolean; architecture: boolean }) {
  useKeys(
    () => ({
      sheet: route.sheet ? { tab: route.sheet.tab, artifacts, documents, architecture, narrowed: route.sheet.tab === 'diff' && diffNarrowed() } : null,
      decision: route.sheet ? front?.decision ?? null : null,
      next: next !== null,
      guarded: guarded(),
      held: holding(),
      repos,
    }),
    (action, e) => {
      if (action.type === 'next') openSheet(next!, 'overview');
      else if (action.type === 'new-task') openNewTask();
      else if (action.type === 'bug') openBugReport();
      else if (action.type === 'keys') toggleKeys();
      else if (action.type === 'undo') undo();
      else if (action.type === 'tab') showTab(action.tab);
      else if (action.type === 'file') stepFile(action.step);
      else if (action.type === 'back') closeSheet();
      else if (action.type === 'close' && action.what === 'tooltip') return;
      else if (action.type === 'close' && action.what === 'file') widenDiff();
      else front?.act(action, e);
    },
  );
}
