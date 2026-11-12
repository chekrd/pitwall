import { useSyncExternalStore } from 'react';
import type { RoundAnswers } from './types.ts';

const KEY = 'pitwall:round-answers';
const KEPT = 30;

const NONE: RoundAnswers = {};

interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// The answers given so far to each round of questions, by decision. They are a draft, as a reply box's text is, shared
// by the round's card and its task page. A round takes a while to answer, so they outlive the window, in localStorage.
export function createRoundAnswers(storage: Storage | null) {
  let all = new Map<string, RoundAnswers>();
  try {
    all = new Map(JSON.parse(storage?.getItem(KEY) ?? '[]'));
  } catch {
    // Unreadable answers start over.
  }
  const subscribers = new Set<() => void>();
  return {
    of: (key: string | null) => (key && all.get(key)) || NONE,
    set(key: string, answers: RoundAnswers) {
      all = new Map(all);
      all.delete(key);
      all.set(key, answers);
      for (const old of all.keys()) if (all.size > KEPT) all.delete(old);
      try {
        storage?.setItem(KEY, JSON.stringify([...all]));
      } catch {
        // A page without storage keeps them in memory only.
      }
      for (const fn of subscribers) fn();
    },
    subscribe: (fn: () => void) => {
      subscribers.add(fn);
      return () => void subscribers.delete(fn);
    },
  };
}

function localStorageOrNull() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export const roundAnswers = createRoundAnswers(typeof document === 'undefined' ? null : localStorageOrNull());

export function useRoundAnswers(key: string | null): [RoundAnswers, (answers: RoundAnswers) => void] {
  const answers = useSyncExternalStore(roundAnswers.subscribe, () => roundAnswers.of(key));
  return [answers, (next) => key && roundAnswers.set(key, next)];
}
