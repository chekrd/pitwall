import { randomUUID } from 'node:crypto';
import { draftMessage } from './codeRef.ts';
import type { Parked, Session } from './db.ts';
import { decisionKey } from './decision.ts';

export const MAX_PARKED = 50;
const MAX_TEXT = 20_000;

function cleanText(text: string) {
  const t = text.trim();
  if (!t) throw new Error('the draft is empty');
  if (t.length > MAX_TEXT) throw new Error('the draft is too long');
  return t;
}

export function addParked(list: readonly Parked[], body: { text: string; auto?: boolean | undefined; ref?: Parked['ref'] | undefined }, now = Date.now()): Parked[] {
  if (list.length >= MAX_PARKED) throw new Error(`a task holds at most ${MAX_PARKED} drafts`);
  const auto = body.auto === true;
  return [...list, { id: randomUUID(), text: cleanText(body.text), auto, armedAt: auto ? now : null, at: now, ...(body.ref && { ref: body.ref }) }];
}

export function editParked(list: readonly Parked[], body: { draft: string; text?: string | undefined; auto?: boolean | undefined }, now = Date.now()): Parked[] {
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

export interface Due {
  id: string;
  ids: string[];
  text: string;
}

// Whether Claude's reply ends by asking something: its last paragraph ends on a question mark, past the closing marks
// of Markdown emphasis, code, quotes and brackets.
export function endsOnQuestion(message: string | null) {
  const last = message?.trim().split(/\n\s*\n/).at(-1) ?? '';
  return /\?[\s*_`"'”’)\]]*$/.test(last);
}

// Watches each task for a real end of its turn: working, then idle (a permission prompt or a menu is not one). The first
// draft armed before that end goes out at once, unless the turn ended on a question, which a draft would answer by
// accident; the next one waits for the end of the turn it starts. Not when you replied meanwhile, a prompt in the
// terminal set Claude working again, or the task is paused or archived. Only ends seen while the board runs count, and
// arming one while it is already your turn, as no other end is coming.
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
      ends.delete(s.id);
      const armed = s.parked.filter((p) => p.auto && p.armedAt !== null && p.armedAt <= end);
      const replied = !!s.answered && s.answered.at >= end;
      if (!armed.length || replied || s.archived || s.interrupted || s.turnError || pausing.includes(s.id) || decisionKey(s) || endsOnQuestion(s.lastMessage)) continue;
      due.push({ id: s.id, ids: [armed[0].id], text: draftMessage(armed[0]) });
    }
    for (const id of last.keys()) if (!all.some((s) => s.id === id)) last.delete(id);
    return due;
  }

  function armed(s: Session, now = Date.now()) {
    if (s.status !== 'idle') return;
    last.set(s.id, s.status);
    ends.set(s.id, now);
  }

  return { observe, armed };
}
