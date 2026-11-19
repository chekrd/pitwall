import { useEffect, useState, useSyncExternalStore } from 'react';
import { decisionKey } from '../../server/decision.ts';
import { kindOf, startPicks, targetOf, togglePick } from './answers.ts';
import type { Menu, MenuAnswer, Session } from './types.ts';

export const GUARD_MS = 900;
const KEPT = 100;
const PICKS_KEY = 'pitwall:picks';

function sessionStorageOrNull() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

// A menu's picks, by decision. They are a draft, as a reply box's text is: the menu that comes back, after an Undo,
// another task or a reload, shows them as they were.
let picksKept: Map<string, MenuAnswer[]> = (() => {
  try {
    return new Map(JSON.parse(sessionStorageOrNull()?.getItem(PICKS_KEY) ?? '[]'));
  } catch {
    return new Map();
  }
})();

function keepPicks(key: string, value: readonly MenuAnswer[]) {
  picksKept = new Map(picksKept).set(key, value.map((p) => ({ labels: [...p.labels], other: p.other })));
  for (const old of picksKept.keys()) if (picksKept.size > KEPT) picksKept.delete(old);
  try {
    sessionStorageOrNull()?.setItem(PICKS_KEY, JSON.stringify([...picksKept]));
  } catch {
    // A page without storage keeps them in memory only.
  }
}

// State that belongs to one decision: a new decision on the same task starts it afresh.
export function useKeyed<T>(key: string | null, initial: () => T): [T, (value: T) => void] {
  const [state, setState] = useState(() => ({ key, value: initial() }));
  const current = state.key === key ? state : { key, value: initial() };
  if (current !== state) setState(current);
  return [current.value, (value: T) => setState({ key, value })];
}

// What a decision's options and keys share: a menu's picks, which belong to that one menu, so a menu that replaces it
// in the same snapshot starts with its own.
export function useDecision(session: Session, menu: Menu | null) {
  const key = decisionKey(session);
  const [picks, showPicks] = useKeyed<MenuAnswer[]>(key, () => startPicks(key ? picksKept.get(key) ?? null : null, menu));
  const setPicks = (value: MenuAnswer[]) => {
    showPicks(value);
    if (key) keepPicks(key, value);
  };

  // The compiler reads what a callback uses during render, so a `menu!.questions` there would throw without a menu.
  const questions = menu?.questions ?? [];
  // A menu of one single-choice question answers with the pick, as the terminal does.
  const lone = questions.length === 1 && !questions[0].multiSelect;
  const toggle = (question: number, label: string) => setPicks(togglePick(picks, question, label, questions[question]?.multiSelect === true));
  // An own answer to a question replaces its picks.
  const answerOwn = (question: number, other: string) => setPicks(picks.map((p, i) => (i === question ? { labels: other ? [] : p.labels, other } : p)));
  return { key, picks, setPicks, toggle, answerOwn, questions, lone };
}

// What a decision asks of the reader: when it changes under them, the keys and presses that answer wait a moment.
export const signature = (s: Session, now = Date.now()) => `${kindOf(s, now)}:${decisionKey(s)}:${targetOf(s, now)}`;

// The answer keys and presses do nothing for 0.9 s after a decision comes up or changes, so a press aimed at what was
// there before does not answer what replaced it.
let guardUntil = 0;
const guardSubscribers = new Set<() => void>();
const guardChanged = () => {
  for (const fn of guardSubscribers) fn();
};

export const guarded = (now = Date.now()) => now < guardUntil;

function startGuard() {
  guardUntil = Date.now() + GUARD_MS;
  guardChanged();
  setTimeout(guardChanged, GUARD_MS + 1);
}

const subscribeGuard = (fn: () => void) => {
  guardSubscribers.add(fn);
  return () => void guardSubscribers.delete(fn);
};

// Starts the guard whenever `sig` changes while shown, and draws whether it holds.
export function useGuard(sig: string) {
  useEffect(() => {
    startGuard();
  }, [sig]);
  return useSyncExternalStore(subscribeGuard, () => guarded());
}
