import { useSyncExternalStore } from 'react';

// The version of each task's documents last read in this browser, to mark one that changed since.

const KEY = 'pitwall:read-versions';

let read: Record<string, number> = load();
const listeners = new Set<() => void>();

function load(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

const keyOf = (task: string, path: string) => `${task} ${path}`;

// A document never read here is new to you rather than changed.
export const changedSince = (seen: number | undefined, current: number) => seen !== undefined && current > seen;

export function markRead(task: string, path: string, version: number) {
  const key = keyOf(task, path);
  if (read[key] === version) return;
  read = { ...read, [key]: version };
  try {
    localStorage.setItem(KEY, JSON.stringify(read));
  } catch {
    // A page without storage keeps it in memory only.
  }
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export function useReadVersions(task: string) {
  const all = useSyncExternalStore(subscribe, () => read);
  return (path: string): number | undefined => all[keyOf(task, path)];
}
