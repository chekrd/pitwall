import { openDecision } from '../../server/decision.ts';
import type { Session } from './types.ts';
import { attentionOf, type Attention } from './util.ts';

const attentionRank: Record<Attention, number> = { decide: 0, focus: 1, idle: 2, working: 3, exited: 4, clearing: 5 };

const group = (s: Session) => attentionRank[attentionOf(s)];

// Since when a task has waited on the developer: a decision since it was asked, anything else since its row last
// changed, which the sync's alive mark leaves alone.
export const waitingSince = (s: Session) => openDecision(s)?.askedAt ?? s.updatedAt;

const waits = (s: Session) => group(s) <= attentionRank.idle;

// Decisions first, then prompts only the terminal can answer, then finished turns, each the longest waiting first;
// then the tasks at work and the ended ones, oldest first.
export function compare(a: Session, b: Session) {
  const g = group(a) - group(b);
  if (g) return g;
  return (waits(a) ? waitingSince(a) - waitingSince(b) : 0) || a.createdAt - b.createdAt;
}

export function orderTiles(sessions: Session[]) {
  return {
    active: sessions.filter((s) => !s.archived).sort(compare),
    archived: sessions.filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

const WAITS: readonly Attention[] = ['decide', 'focus', 'idle'];

// The tasks that wait on the developer, in the Wall's order. `busy` are the ones whose send from this page is held
// or not yet confirmed, which have been answered already.
export function waitingOf(sessions: readonly Session[], busy: ReadonlySet<string>, now = Date.now()) {
  return sessions
    .filter((s) => !s.archived && s.status !== 'exited' && !busy.has(s.id) && WAITS.includes(attentionOf(s, now)))
    .sort(compare);
}

// The decision to go to next, and how many wait besides the task open now: the first in the Wall's order, or, from a
// task whose decision waits, the one after it, round to the start, so going on without answering reaches each.
export function nextDecision(waiting: readonly Session[], current: string | null, now = Date.now()) {
  const decisions = waiting.filter((s) => attentionOf(s, now) === 'decide');
  const at = decisions.findIndex((s) => s.id === current);
  const others = at < 0 ? decisions : [...decisions.slice(at + 1), ...decisions.slice(0, at)];
  return { next: others[0] ?? null, count: others.length };
}

const GROUPS = [['decide', 'decision', 'decisions'], ['focus', 'terminal prompt', 'terminal prompts'], ['idle', 'finished turn', 'finished turns']] as const;

// "3 decisions · 1 terminal prompt · 2 finished turns"
export function waitingLabel(waiting: readonly Session[], now = Date.now()) {
  const attention = waiting.map((s) => attentionOf(s, now));
  return GROUPS.flatMap(([a, one, many]) => {
    const n = attention.filter((x) => x === a).length;
    return n ? [`${n} ${n === 1 ? one : many}`] : [];
  }).join(' · ');
}

export const orderKey = (sessions: Session[]) => {
  const { active, archived } = orderTiles(sessions);
  return [...active, ...archived].map((s) => `${s.id}:${group(s)}`).join();
};
