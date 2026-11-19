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

export const orderKey = (sessions: Session[]) => {
  const { active, archived } = orderTiles(sessions);
  return [...active, ...archived].map((s) => `${s.id}:${group(s)}`).join();
};
