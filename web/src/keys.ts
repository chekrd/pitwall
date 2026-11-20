import type { Kind } from './answers.ts';

// The board's keys as data: KEYS drives keyAction and the Keys dialog's rows, so the dialog cannot drift from what
// the keys do. useKeys reads the DOM into a KeyContext; nothing here touches it.

export type Tab = 'overview' | 'diff' | 'artifacts' | 'conversation' | 'documents';

export interface Key {
  key: string;
  code: string;
  repeat?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

export interface Target {
  // A field: its keys are its own.
  editable: boolean;
  // A button, link or the like, which Enter and Space activate.
  control: boolean;
  option: boolean;
  // The diff's resize handle, which takes its own arrows.
  resizer: boolean;
}

// The open decision a task's Overview shows.
export interface Decision {
  kind: Kind;
  // Claude's details to show or hide.
  details: boolean;
  primary: boolean;
  // A reply box to write in.
  reply: boolean;
}

export interface KeyContext {
  // `narrowed`: the Diff tab shows one file or one folder, which Esc steps back from.
  sheet: { tab: Tab; artifacts: boolean; documents: boolean; narrowed: boolean } | null;
  decision: Decision | null;
  // Another task waits for a decision.
  next: boolean;
  guarded: boolean;
  // A send waits out its hold, which Undo can still take back.
  held: boolean;
  repos: boolean;
  target: Target;
  // A modal dialog other than the sheet: only ? passes, to close Keys.
  modal: 'keys' | 'other' | null;
  // The `popover` attribute of each open popover.
  popovers: readonly string[];
  // A tooltip shows: an Esc only dismisses it, unless a send waits to go out.
  tip: boolean;
}

export type Action =
  | { type: 'primary' }
  | { type: 'details' }
  | { type: 'compose' }
  | { type: 'next' }
  | { type: 'undo' }
  | { type: 'new-task' }
  | { type: 'bug' }
  | { type: 'keys' }
  | { type: 'tab'; tab: Tab }
  | { type: 'file'; step: 1 | -1 }
  | { type: 'close'; what: 'tooltip' | 'file' }
  | { type: 'back' };

export const KEYS_DIALOG = 'keys';
export const SHEET_DIALOG = 'task-sheet';

type Scope = 'wall' | 'sheet';

interface Row {
  keys: string;
  help: string;
  scopes: Scope[];
  // An answer key: it waits out the guard after the decision changed.
  guarded?: boolean;
  repeats?: boolean;
  matches: (e: Key) => boolean;
  act: (ctx: KeyContext, e: Key) => Action | null;
}

// Digits by the physical key: on many non-US layouts the number row types letters or symbols without Shift.
const digit = (e: Key) => Number(/^(?:Digit|Numpad)([1-9])$/.exec(e.code)?.[1] ?? 0);
const named = (...keys: string[]) => (e: Key) => keys.includes(e.key) || keys.includes(e.key.toLowerCase());

// Esc's one order, in the Esc row below. A dialog or the ⋯ menu over the board takes Esc itself, but for a tooltip on it.
function escape(ctx: KeyContext): Action | null {
  if (ctx.modal || ctx.popovers.includes('auto')) return ctx.tip ? { type: 'close', what: 'tooltip' } : null;
  if (ctx.held) return { type: 'undo' };
  if (ctx.tip) return { type: 'close', what: 'tooltip' };
  if (ctx.sheet) return ctx.sheet.narrowed ? { type: 'close', what: 'file' } : { type: 'back' };
  return null;
}

export const KEYS: readonly Row[] = [
  { keys: '↵', help: 'On a decision: what its main button says, Claude\'s recommended option, the picks or the answers', scopes: ['sheet'], guarded: true, matches: named('Enter'), act: (ctx) => (ctx.decision?.primary ? { type: 'primary' } : null) },
  { keys: 'Space', help: "On a decision: show or hide Claude's details", scopes: ['sheet'], matches: named(' '), act: (ctx) => (ctx.decision?.details ? { type: 'details' } : null) },
  { keys: 'W', help: 'On a decision: write your own answer', scopes: ['sheet'], guarded: true, matches: named('w'), act: (ctx) => (ctx.decision?.reply ? { type: 'compose' } : null) },
  { keys: 'D', help: 'Go to the next task that waits for a decision', scopes: ['wall', 'sheet'], matches: named('d'), act: (ctx) => (ctx.next ? { type: 'next' } : null) },
  { keys: 'Z', help: 'Take back the last send while it waits to go out', scopes: ['wall', 'sheet'], matches: named('z'), act: () => ({ type: 'undo' }) },
  { keys: 'N', help: 'New task', scopes: ['wall', 'sheet'], matches: named('n'), act: (ctx) => (ctx.repos ? { type: 'new-task' } : null) },
  { keys: 'B', help: 'Bug report: say what went wrong, and a Pitwall task fixes it', scopes: ['wall', 'sheet'], matches: named('b'), act: () => ({ type: 'bug' }) },
  {
    keys: '1 / 2 / 3 / 4 / 5', help: 'In an open task: Overview, Conversation, Diff, Artifacts, Documents', scopes: ['sheet'], matches: (e) => digit(e) > 0 && digit(e) <= 5,
    act: (ctx, e) => {
      const tab = ([null, 'overview', 'conversation', 'diff', 'artifacts', 'documents'] as const)[digit(e)];
      return !tab || (tab === 'artifacts' && !ctx.sheet?.artifacts) || (tab === 'documents' && !ctx.sheet?.documents) ? null : { type: 'tab', tab };
    },
  },
  { keys: 'J / K', help: 'In the diff: next or previous file', scopes: ['sheet'], repeats: true, matches: named('j', 'k'), act: (ctx, e) => (ctx.sheet?.tab === 'diff' ? { type: 'file', step: e.key.toLowerCase() === 'j' ? 1 : -1 } : null) },
  { keys: 'Esc', help: 'Take back a send that waits to go out; else close what is open; from a task, back to the Wall', scopes: ['wall', 'sheet'], matches: named('Escape'), act: escape },
  { keys: '?', help: 'These keys', scopes: ['wall', 'sheet'], matches: named('?'), act: () => ({ type: 'keys' }) },
];

// The row a key press belongs to, or null when the press is not the board's: a shortcut with a modifier, a key in a
// field, a key but Esc on the resize handle, Enter or Space on a control (native activation wins, except Space on an option,
// which toggles the details), or a dialog or the ⋯ menu open, but for Esc on a tooltip over them. Toasts are popovers
// too, but not menus. Esc is decided here alone: a field's own Esc stays the field's.
export function rowFor(ctx: KeyContext, e: Key): Row | null {
  if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (ctx.target.editable || (ctx.target.resizer && e.key !== 'Escape')) return null;
  const tip = e.key === 'Escape' && ctx.tip;
  if (ctx.popovers.includes('auto') && !tip) return null;
  if (ctx.modal && !tip && !(ctx.modal === 'keys' && e.key === '?')) return null;
  if (ctx.target.control && (e.key === 'Enter' || (e.key === ' ' && !ctx.target.option))) return null;
  const scope: Scope = ctx.sheet ? 'sheet' : 'wall';
  return KEYS.find((r) => r.scopes.includes(scope) && r.matches(e)) ?? null;
}

export function keyAction(ctx: KeyContext, e: Key): Action | null {
  const row = rowFor(ctx, e);
  if (!row || (row.guarded && ctx.guarded) || (e.repeat && !row.repeats)) return null;
  return row.act(ctx, e);
}

export const LOCK_MS = 1000;

// Focus lost to a field that unmounted lands on the page, and the rest of a sentence would run as shortcuts: Enter
// sends the recommended option, D opens another task. So the keys stay off while typing goes on: each key pressed while locked keeps
// the lock for another second and does nothing else. A click ends it, and so does Esc, which goes through: a reply
// sent with Enter starts the lock, and Esc right after it takes the send back.
export function typingLock(now: () => number = Date.now) {
  let until = 0;
  return {
    start() {
      until = now() + LOCK_MS;
    },
    end() {
      until = 0;
    },
    locked: () => now() < until,
    takes(e: Key) {
      if (now() >= until) return false;
      if (e.key === 'Escape') {
        until = 0;
        return false;
      }
      until = now() + LOCK_MS;
      return true;
    },
  };
}
