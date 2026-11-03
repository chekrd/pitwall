import { randomUUID } from 'node:crypto';
import type { Parked, Session } from './db.ts';
import { decisionKey } from './decision.ts';

export const MAX_PARKED = 50;
const MAX_TEXT = 20_000;

// A turn's summary says whether it ended on a question; past this it is not waited for any longer.
export const SUMMARY_WAIT_MS = 60_000;

function cleanText(text: unknown) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('the draft is empty');
  if (t.length > MAX_TEXT) throw new Error('the draft is too long');
  return t;
}

export function addParked(list: readonly Parked[], body: { text?: unknown; auto?: unknown }, now = Date.now()): Parked[] {
  if (list.length >= MAX_PARKED) throw new Error(`a task holds at most ${MAX_PARKED} drafts`);
  const auto = body.auto === true;
  return [...list, { id: randomUUID(), text: cleanText(body.text), auto, armedAt: auto ? now : null, at: now }];
}

// Arming counts from the moment it is switched on, so a turn that had already ended does not send it.
export function editParked(list: readonly Parked[], body: { draft?: unknown; text?: unknown; auto?: unknown }, now = Date.now()): Parked[] {
  const found = list.find((p) => p.id === body.draft);
  if (!found) throw new Error('this draft is gone');
  const auto = typeof body.auto === 'boolean' ? body.auto : found.auto;
  const next: Parked = {
    ...found,
    text: body.text === undefined ? found.text : cleanText(body.text),
    auto,
    armedAt: auto ? (found.auto ? found.armedAt : now) : null,
  };
  return list.map((p) => (p === found ? next : p));
}

export const removeParked = (list: readonly Parked[], ids: readonly unknown[]) => list.filter((p) => !ids.includes(p.id));

export const parkedMessage = (items: readonly Pick<Parked, 'text'>[]) => items.map((p) => p.text).join('\n\n');

export interface Due {
  id: string;
  ids: string[];
  text: string;
}

// Watches each task for a real end of its turn: working, then idle (a permission prompt or a menu is not one). The drafts
// armed before that end go out as one message once the turn's summary says whether it ended on a question, which a
// draft would answer by accident; not when you replied meanwhile, a prompt in the terminal set Claude working again, or
// the task is paused or archived. Only ends seen while the board runs count.
export function turnEnds() {
  const last = new Map<string, Session['status']>();
  const ends = new Map<string, number>();

  function observe(all: readonly Session[], pausing: readonly string[], now = Date.now()): Due[] {
    const due: Due[] = [];
    for (const s of all) {
      const was = last.get(s.id);
      last.set(s.id, s.status);
      if (s.status !== 'idle') {
        ends.delete(s.id);
        continue;
      }
      if (was === 'working') ends.set(s.id, now);
      const end = ends.get(s.id);
      if (!end) continue;
      const armed = s.parked.filter((p) => p.auto && p.armedAt !== null && p.armedAt < end);
      const replied = !!s.answered && s.answered.at >= end;
      if (!armed.length || replied || s.archived || s.interrupted || s.turnError || pausing.includes(s.id) || s.menu || s.question) {
        ends.delete(s.id);
        continue;
      }
      if (s.summary?.basis !== s.lastTurn && now - end < SUMMARY_WAIT_MS) continue;
      ends.delete(s.id);
      if (decisionKey(s)) continue;
      due.push({ id: s.id, ids: armed.map((p) => p.id), text: parkedMessage(armed) });
    }
    for (const id of last.keys()) if (!all.some((s) => s.id === id)) last.delete(id);
    return due;
  }

  return { observe };
}
