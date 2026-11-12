import type { Kind } from './deck.ts';

// The board's keys as data: KEYS drives keyAction and the Keys dialog's rows, so the dialog cannot drift from what
// the keys do. useKeys reads the DOM into a KeyContext; nothing here touches it.

export type Tab = 'overview' | 'diff' | 'artifacts' | 'conversation';

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

export interface Card {
  kind: Kind;
  // Ask and end of turn: how many options there are.
  options: number;
  // A menu: how many options each question has.
  questions: number[];
  // A menu of one single-choice question, which a pick sends.
  lone: boolean;
  // A done second opinion, which E copies into the composer.
  suggestion: boolean;
  primary: boolean;
  why: boolean;
  composing: boolean;
}

export interface KeyContext {
  view: 'queue' | 'wall';
  // `narrowed`: the Diff tab shows one file or one folder, which Esc steps back from.
  sheet: { tab: Tab; artifacts: boolean; narrowed: boolean } | null;
  card: Card | null;
  deck: number;
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
  | { type: 'option'; index: number }
  | { type: 'pick'; question: number; option: number; send: boolean }
  | { type: 'primary' }
  | { type: 'skip' }
  | { type: 'previous' }
  | { type: 'details' }
  | { type: 'compose' }
  | { type: 'edit' }
  | { type: 'elaborate' }
  | { type: 'open'; tab: 'overview' | 'diff' }
  | { type: 'archive' }
  | { type: 'undo' }
  | { type: 'view'; to: 'queue' | 'wall' }
  | { type: 'new-task' }
  | { type: 'bug' }
  | { type: 'keys' }
  | { type: 'tab'; tab: Tab }
  | { type: 'file'; step: 1 | -1 }
  | { type: 'close'; what: 'why' | 'composer' | 'tooltip' | 'file' }
  | { type: 'back' };

export const KEYS_DIALOG = 'keys';
export const SHEET_DIALOG = 'task-sheet';

type Scope = 'queue' | 'wall' | 'sheet';

interface Row {
  keys: string;
  help: string;
  scopes: Scope[];
  // An answer key: it waits out the guard after a card change.
  guarded?: boolean;
  repeats?: boolean;
  matches: (e: Key) => boolean;
  act: (ctx: KeyContext, e: Key) => Action | null;
}

// Digits by the physical key: on many non-US layouts the number row types letters or symbols without Shift.
const digit = (e: Key) => Number(/^(?:Digit|Numpad)([1-9])$/.exec(e.code)?.[1] ?? 0);
const named = (...keys: string[]) => (e: Key) => keys.includes(e.key) || keys.includes(e.key.toLowerCase());
const deciding = (card: Card | null) => card?.kind === 'ask' || card?.kind === 'turn';

function numbered(card: Card | null, n: number): Action | null {
  if (deciding(card)) return n <= card!.options ? { type: 'option', index: n - 1 } : null;
  if (card?.kind !== 'menu') return null;
  let at = n - 1;
  for (const [question, count] of card.questions.entries()) {
    if (at < count) return { type: 'pick', question, option: at, send: card.lone };
    at -= count;
  }
  return null;
}

// Esc's one order, in the Esc row below. A dialog or the ⋯ menu over the board takes Esc itself, but for a tooltip on it.
function escape(ctx: KeyContext): Action | null {
  if (ctx.modal || ctx.popovers.includes('auto')) return ctx.tip ? { type: 'close', what: 'tooltip' } : null;
  if (ctx.held) return { type: 'undo' };
  if (ctx.tip) return { type: 'close', what: 'tooltip' };
  if (ctx.sheet) return ctx.sheet.narrowed ? { type: 'close', what: 'file' } : { type: 'back' };
  if (ctx.view === 'wall') return ctx.deck ? { type: 'view', to: 'queue' } : null;
  if (ctx.card?.why) return { type: 'close', what: 'why' };
  return ctx.card?.composing ? { type: 'close', what: 'composer' } : null;
}

export const KEYS: readonly Row[] = [
  { keys: '1 – 9', help: 'Send that option; in a menu, pick it', scopes: ['queue'], guarded: true, matches: (e) => digit(e) > 0, act: (ctx, e) => numbered(ctx.card, digit(e)) },
  { keys: '↵', help: 'What the main button says: send the choice, the picks or the answers, or open the terminal; on a finished turn, go to the reply box', scopes: ['queue'], guarded: true, matches: named('Enter'), act: (ctx) => (ctx.card?.primary ? { type: 'primary' } : null) },
  { keys: '→', help: 'Skip: the card goes to the back of the deck', scopes: ['queue'], repeats: true, matches: named('ArrowRight'), act: (ctx) => (ctx.card && ctx.deck > 1 ? { type: 'skip' } : null) },
  { keys: '←', help: 'Bring the last card back to the front', scopes: ['queue'], repeats: true, matches: named('ArrowLeft'), act: (ctx) => (ctx.card && ctx.deck > 1 ? { type: 'previous' } : null) },
  { keys: 'Space', help: "Show or hide Claude's details", scopes: ['queue'], matches: named(' '), act: (ctx) => (deciding(ctx.card) ? { type: 'details' } : null) },
  { keys: 'W', help: 'Write your own answer', scopes: ['queue'], guarded: true, matches: named('w'), act: (ctx) => (deciding(ctx.card) || ctx.card?.kind === 'idle' || ctx.card?.kind === 'round' ? { type: 'compose' } : null) },
  { keys: 'E', help: 'Edit the suggestion before sending it', scopes: ['queue'], guarded: true, matches: named('e'), act: (ctx) => (deciding(ctx.card) && ctx.card!.suggestion ? { type: 'edit' } : null) },
  { keys: 'Y', help: 'Elaborate: the background, read from the code', scopes: ['queue'], matches: named('y'), act: (ctx) => (deciding(ctx.card) ? { type: 'elaborate' } : null) },
  { keys: 'O / D', help: 'Open the task on Overview or Diff', scopes: ['queue'], matches: named('o', 'd'), act: (ctx, e) => (ctx.card ? { type: 'open', tab: e.key.toLowerCase() === 'o' ? 'overview' : 'diff' } : null) },
  { keys: 'X', help: 'Archive a finished task', scopes: ['queue'], guarded: true, matches: named('x'), act: (ctx) => (ctx.card?.kind === 'idle' ? { type: 'archive' } : null) },
  { keys: 'Z', help: 'Take back the last send while it waits to go out', scopes: ['queue', 'wall', 'sheet'], matches: named('z'), act: () => ({ type: 'undo' }) },
  { keys: 'V', help: 'Switch between Queue and Wall', scopes: ['queue', 'wall'], matches: named('v'), act: (ctx) => ({ type: 'view', to: ctx.view === 'queue' ? 'wall' : 'queue' }) },
  { keys: 'N', help: 'New task', scopes: ['queue', 'wall', 'sheet'], matches: named('n'), act: (ctx) => (ctx.repos ? { type: 'new-task' } : null) },
  { keys: 'B', help: 'Bug report: say what went wrong, and a Pitwall task fixes it', scopes: ['queue', 'wall', 'sheet'], matches: named('b'), act: () => ({ type: 'bug' }) },
  {
    keys: '1 / 2 / 3 / 4', help: 'In an open task: Overview, Conversation, Diff, Artifacts', scopes: ['sheet'], matches: (e) => digit(e) > 0 && digit(e) <= 4,
    act: (ctx, e) => (digit(e) === 1 ? { type: 'tab', tab: 'overview' } : digit(e) === 2 ? { type: 'tab', tab: 'conversation' } : digit(e) === 3 ? { type: 'tab', tab: 'diff' }
      : ctx.sheet?.artifacts ? { type: 'tab', tab: 'artifacts' } : null),
  },
  { keys: 'J / K', help: 'In the diff: next or previous file', scopes: ['sheet'], repeats: true, matches: named('j', 'k'), act: (ctx, e) => (ctx.sheet?.tab === 'diff' ? { type: 'file', step: e.key.toLowerCase() === 'j' ? 1 : -1 } : null) },
  { keys: 'Esc', help: 'Take back a send that waits to go out; else close what is open; from a task, back to where it was opened; then back to the queue', scopes: ['queue', 'wall', 'sheet'], matches: named('Escape'), act: escape },
  { keys: '?', help: 'These keys', scopes: ['queue', 'wall', 'sheet'], matches: named('?'), act: () => ({ type: 'keys' }) },
];

// The row a key press belongs to, or null when the press is not the board's: a shortcut with a modifier, a key in a
// field, a key but Esc on the resize handle, Enter or Space on a control (native activation wins, except Space on an option,
// which toggles the details), or a dialog or the ⋯ menu open, but for Esc on a tooltip over them. Toasts and hover
// cards are popovers too, but not menus. Esc is decided here alone: a field's own Esc stays the field's.
export function rowFor(ctx: KeyContext, e: Key): Row | null {
  if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (ctx.target.editable || (ctx.target.resizer && e.key !== 'Escape')) return null;
  const tip = e.key === 'Escape' && ctx.tip;
  if (ctx.popovers.includes('auto') && !tip) return null;
  if (ctx.modal && !tip && !(ctx.modal === 'keys' && e.key === '?')) return null;
  if (ctx.target.control && (e.key === 'Enter' || (e.key === ' ' && !ctx.target.option))) return null;
  const scope: Scope = ctx.sheet ? 'sheet' : ctx.view;
  return KEYS.find((r) => r.scopes.includes(scope) && r.matches(e)) ?? null;
}

export function keyAction(ctx: KeyContext, e: Key): Action | null {
  const row = rowFor(ctx, e);
  if (!row || (row.guarded && ctx.guarded) || (e.repeat && !row.repeats)) return null;
  return row.act(ctx, e);
}

export const LOCK_MS = 1000;

// Focus lost to a field that unmounted lands on the page, and the rest of a sentence would run as shortcuts: a
// digit sends an option, X archives. So the keys stay off while typing goes on: each key pressed while locked keeps
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
