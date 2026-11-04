import { randomUUID } from 'node:crypto';
import type { Aside, AsideTurn, Session } from './db.ts';

export const MAX_ASIDES = 10;
const MAX_QUESTION = 10_000;

const FIRST = `This is a side question from the developer, asked in a copy of this conversation. The original session carries on with the task and never sees this copy. Answer the question only: do not continue the task and do not change anything. You can read files and the web, but not edit files or run commands.

Question: `;

const FOLLOW_UP = 'A follow-up side question (the same rules: answer it, change nothing):\n\n';

export const asidePrompt = (question: string, first: boolean) => (first ? FIRST : FOLLOW_UP) + question;

export interface AsideRun {
  fork: string;
  answer: string;
}

export interface AsideDeps {
  get: (id: string) => Session | undefined;
  save: (id: string, asides: Aside[]) => void;
  // Forks the task's conversation when `fork` is null, else resumes that fork.
  run: (s: Session, prompt: string, fork: string | null, signal: AbortSignal, activity: (text: string) => void) => Promise<AsideRun>;
  discard: (s: Session, fork: string) => Promise<void>;
  now?: () => number;
}

// Each aside answers one question at a time; a follow-up waits for the answer before it.
export function asking({ get, save, run, discard, now = Date.now }: AsideDeps) {
  const running = new Map<string, AbortController>();

  const must = (id: string) => {
    const s = get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    return s;
  };

  function change(id: string, asideId: string, fn: (a: Aside) => Aside) {
    const s = get(id);
    if (!s || !s.asides.some((a) => a.id === asideId)) return false;
    save(id, s.asides.map((a) => (a.id === asideId ? fn(a) : a)));
    return true;
  }

  const lastTurn = (a: Aside, patch: Partial<AsideTurn>) => ({ ...a, turns: a.turns.map((t, i) => (i === a.turns.length - 1 ? { ...t, ...patch } : t)) });

  async function answer(id: string, asideId: string, question: string, fork: string | null) {
    const controller = new AbortController();
    running.set(asideId, controller);
    let last = 0;
    const activity = (text: string) => {
      if (now() - last < 2000) return;
      last = now();
      change(id, asideId, (a) => ({ ...a, activity: text }));
    };
    const s = must(id);
    try {
      const out = await run(s, asidePrompt(question, !fork), fork, controller.signal, activity);
      const kept = change(id, asideId, (a) => ({ ...lastTurn(a, { answer: out.answer }), fork: out.fork, state: 'done', activity: null, at: now() }));
      if (!kept) await discard(s, out.fork).catch(() => {});
    } catch (err) {
      const error = controller.signal.aborted ? 'stopped' : err instanceof Error ? err.message : String(err);
      change(id, asideId, (a) => ({ ...lastTurn(a, { error }), state: 'failed', activity: null, at: now() }));
    } finally {
      running.delete(asideId);
    }
  }

  // A question without `aside` opens a new aside; with it, a follow-up in that aside's fork. Returns the aside's id.
  function ask(id: string, body: { text: string; aside?: string | null | undefined }) {
    const s = must(id);
    const question = body.text.trim();
    if (!question) throw new Error('the question is empty');
    if (question.length > MAX_QUESTION) throw new Error('the question is too long');
    const turn: AsideTurn = { question, answer: null, error: null, at: now() };
    if (body.aside === undefined || body.aside === null) {
      if (s.asides.length >= MAX_ASIDES) throw new Error(`close an aside first; a task keeps at most ${MAX_ASIDES}`);
      const aside: Aside = { id: randomUUID(), fork: null, state: 'thinking', activity: null, turns: [turn], at: now() };
      save(id, [...s.asides, aside]);
      void answer(id, aside.id, question, null).catch((err) => console.warn('aside failed', aside.id, err));
      return aside.id;
    }
    const aside = s.asides.find((a) => a.id === body.aside);
    if (!aside) throw new Error('this aside is closed');
    if (aside.state === 'thinking') throw new Error('wait for the answer before asking again');
    change(id, aside.id, (a) => ({ ...a, state: 'thinking', activity: null, turns: [...a.turns, turn], at: now() }));
    void answer(id, aside.id, question, aside.fork).catch((err) => console.warn('aside failed', aside.id, err));
    return aside.id;
  }

  function stop(id: string, asideId: unknown) {
    must(id);
    running.get(String(asideId))?.abort();
  }

  // The fork's transcript goes with it; one still answering is stopped, and its fork discarded once it is back.
  async function close(id: string, asideId: unknown) {
    const s = must(id);
    const aside = s.asides.find((a) => a.id === asideId);
    if (!aside) return;
    running.get(aside.id)?.abort();
    save(id, s.asides.filter((a) => a !== aside));
    if (aside.fork) await discard(s, aside.fork).catch((err) => console.warn('aside fork not removed', aside.fork, err));
  }

  // A task going away takes its asides' forks with it; one still answering discards its fork once it is back.
  async function drop(s: Session) {
    for (const a of s.asides) running.get(a.id)?.abort();
    await Promise.all(s.asides.flatMap((a) => (a.fork ? [discard(s, a.fork).catch((err) => console.warn('aside fork not removed', a.fork, err))] : [])));
  }

  // An aside that was answering when the board stopped has no run any more.
  function settle(all: readonly Session[]) {
    for (const s of all) {
      if (!s.asides.some((a) => a.state === 'thinking' && !running.has(a.id))) continue;
      save(s.id, s.asides.map((a) => (a.state === 'thinking' && !running.has(a.id)
        ? { ...lastTurn(a, { error: 'Pitwall restarted before the answer came' }), state: 'failed', activity: null }
        : a)));
    }
  }

  return { ask, stop, close, drop, settle };
}
