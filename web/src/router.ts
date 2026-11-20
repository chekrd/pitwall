import { useSyncExternalStore } from 'react';

export type Tab = 'overview' | 'diff' | 'artifacts' | 'conversation' | 'documents' | 'architecture';

// What a tab shows of its item, from the query: a document's older version, what changed in a version or in the
// task's architecture, or the architecture's diagram on show.
export interface View {
  version?: number | null | undefined;
  changes?: boolean | undefined;
  diagram?: string | null | undefined;
}

export interface Sheet {
  id: string;
  tab: Tab;
  item: string | null;
  version: number | null;
  changes: boolean;
  diagram: string | null;
}

export interface Route {
  sheet: Sheet | null;
}

const TABS: readonly string[] = ['overview', 'diff', 'artifacts', 'conversation', 'documents', 'architecture'];

const TASK_PATH = /^\/s\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?/;

// What had focus when a task opened over the Wall, to have it back when the task closes.
let opener: HTMLElement | null = null;
export const openerOfTask = () => opener;

// An open task covers the Wall, which keeps its own scroll, so neither resets on a route change.
navigation.addEventListener('navigate', (event) => {
  const url = new URL(event.destination.url);
  if (!event.canIntercept || event.hashChange || event.downloadRequest !== null || event.navigationType === 'reload') return;
  if (url.origin !== location.origin || url.pathname.startsWith('/api')) return;
  if (TASK_PATH.test(url.pathname) && !TASK_PATH.test(location.pathname)) {
    opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  }
  event.intercept({ focusReset: 'manual', scroll: 'manual' });
});

// Old links and an installed app's start URL may name /wall, which is the Wall too.
if (location.pathname === '/wall') history.replaceState(history.state, '', `/${location.search}${location.hash}`);

const subscribe = (fn: () => void) => {
  navigation.addEventListener('currententrychange', fn);
  return () => navigation.removeEventListener('currententrychange', fn);
};

// A task covers the Wall, also when it was loaded cold.
function parse(href: string): Route {
  const url = new URL(href);
  const match = url.pathname.match(TASK_PATH);
  if (!match) return { sheet: null };
  const tab = (TABS.includes(match[2]) ? match[2] : 'overview') as Tab;
  const version = Number(url.searchParams.get('v'));
  return { sheet: { id: match[1], tab, item: match[3] ?? null, version: Number.isInteger(version) && version > 0 ? version : null, changes: url.searchParams.has('changes'), diagram: url.searchParams.get('view') || null } };
}

const current = () => parse(navigation.currentEntry?.url ?? location.href);

export function useRoute() {
  const entry = useSyncExternalStore(subscribe, () => navigation.currentEntry);
  return parse(entry?.url ?? location.href);
}

const WALL = '/';

function query(view: View) {
  const q = new URLSearchParams();
  if (view.version) q.set('v', String(view.version));
  if (view.diagram) q.set('view', view.diagram);
  if (view.changes) q.set('changes', '');
  const text = q.toString().replace(/=(?=&|$)/g, '');
  return text ? `?${text}` : '';
}

export const sessionPath = (id: string, tab: Tab = 'overview', item?: string | null, view: View = {}) => `/s/${id}/${tab}${item ? `/${item}` : ''}${query(view)}`;

// An aborted navigation rejects both promises, which the error toasts would otherwise report.
function settle(result: NavigationResult) {
  result.committed?.catch(() => {});
  result.finished?.catch(() => {});
}

export const go = (path: string, options?: NavigationNavigateOptions) => settle(navigation.navigate(path, options));

// From one task to another replaces the entry, so one step back still goes to the Wall.
export function openSheet(id: string, tab: Tab = 'overview', item?: string | null) {
  go(sessionPath(id, tab, item), { history: current().sheet ? 'replace' : 'push' });
}

// Tabs and artifacts replace the entry, so one step back still closes the sheet.
export function showTab(tab: Tab, item?: string | null, view?: View) {
  const { sheet } = current();
  if (sheet) go(sessionPath(sheet.id, tab, item, view), { history: 'replace' });
}

// Into another diagram of the architecture and out: a step of its own, which Back takes back.
export function showDiagram(item: string | null, view: View) {
  const { sheet } = current();
  if (sheet) go(sessionPath(sheet.id, 'architecture', item, view), { history: 'push' });
}

// Stepping back into another document would load the board afresh and lose what the page shows, such as the toast
// that the task is gone.
export function closeSheet() {
  if (!current().sheet) return;
  const entry = navigation.currentEntry;
  const previous = entry && entry.index > 0 ? navigation.entries()[entry.index - 1] : undefined;
  if (previous?.sameDocument && previous.url && new URL(previous.url).pathname === WALL) settle(navigation.back());
  else go(WALL, { history: 'replace' });
}

export function closeSheetOf(id: string) {
  if (current().sheet?.id === id) closeSheet();
}
