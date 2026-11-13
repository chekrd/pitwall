import { randomUUID } from 'node:crypto';
import type { Aside, AsideTurn, Session } from './db.ts';
import type { RoundQuestion } from './rounds.ts';

export const MAX_ASIDES = 10;
const MAX_QUESTION = 10_000;
const MODEL = /^[a-z][a-z0-9.-]*(\[1m\])?$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const FIRST = `This is a side question from the developer, asked in a copy of this conversation. The original session carries on with the task and never sees this copy. Answer the question only: do not continue the task and do not change anything. You can read files and the web, but not edit files or run commands.

Question: `;

const FOLLOW_UP = 'A follow-up side question (the same rules: answer it, change nothing):\n\n';

export const asidePrompt = (question: string, first: boolean) => (first ? FIRST : FOLLOW_UP) + question;

const ABOUT = `The developer wants to talk one of the questions you asked through before answering it, in a copy of this conversation. The original session still waits for the answers and never sees this copy. Help them decide this one question: say what it turns on, what each answer would lead to, which one you would pick and why, and answer what they ask. Do not ask the other questions again, do not continue the task and do not change anything. You can read files and the web, but not edit files or run commands.

The question: `;

export const DISCUSS = 'Talk me through this question.';

export const aboutPrompt = (q: RoundQuestion, text: string) => `${ABOUT}${q.id} — ${q.title}\n\nThe developer: ${text}`;

export interface AskBody {
  text: string;
  aside?: string | null | undefined;
  about?: Aside['about'] | undefined;
  model?: string | undefined;
  effort?: string | undefined;
}

export interface AsideRun {
  fork: string;
  answer: string;
}

export interface AsideDeps {
  get: (id: string) => Session | undefined;
  save: (id: string, asides: Aside[]) => void;
  // Forks the task's conversation when `fork` is null, else resumes that fork.
  run: (s: Session, aside: Aside, prompt: string, fork: string | null, signal: AbortSignal, activity: (text: string) => void) => Promise<AsideRun>;
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

  async function answer(id: string, asideId: string, prompt: string, fork: string | null) {
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
      const aside = s.asides.find((a) => a.id === asideId)!;
      const out = await run(s, aside, prompt, fork, controller.signal, activity);
      const kept = change(id, asideId, (a) => ({ ...lastTurn(a, { answer: out.answer }), fork: out.fork, state: 'done', activity: null, at: now() }));
      if (!kept) await discard(s, out.fork).catch(() => {});
    } catch (err) {
      const error = controller.signal.aborted ? 'stopped' : err instanceof Error ? err.message : String(err);
      change(id, asideId, (a) => ({ ...lastTurn(a, { error }), state: 'failed', activity: null, at: now() }));
    } finally {
      running.delete(asideId);
    }
  }

  // A question without `aside` opens a new aside; with it, a follow-up in that aside's fork. `about` names a question
  // of the task's open round, which has one aside: the first ask opens it, with nothing said if the developer wrote
  // nothing, and every later one follows up in it. `model` and `effort` are for a new aside's fork. Returns the aside's id.
  function ask(id: string, body: AskBody) {
    const s = must(id);
    const named = body.aside === undefined || body.aside === null ? undefined : s.asides.find((a) => a.id === body.aside);
    const about = body.about ?? named?.about;
    const asked = about && s.round?.key === about.round ? s.round.questions.find((q) => q.id === about.question) : undefined;
    if (about && !asked) throw new Error('this question is no longer open');
    const aside = named ?? (about && s.asides.find((a) => a.about?.round === about.round && a.about.question === about.question));
    const question = body.text.trim() || (asked && !aside ? DISCUSS : '');
    if (!question) throw new Error('the question is empty');
    if (question.length > MAX_QUESTION) throw new Error('the question is too long');
    if (body.model && !MODEL.test(body.model)) throw new Error(`unknown model ${body.model}`);
    if (body.effort && !EFFORTS.includes(body.effort)) throw new Error(`unknown effort ${body.effort}`);
    const turn: AsideTurn = { question, answer: null, error: null, at: now() };
    const first = asked ? aboutPrompt(asked, question) : asidePrompt(question, true);
    if (!aside) {
      if (body.aside !== undefined && body.aside !== null) throw new Error('this aside is closed');
      if (!about && s.asides.filter((a) => !a.about).length >= MAX_ASIDES) throw new Error(`close an aside first; a task keeps at most ${MAX_ASIDES}`);
      const opened: Aside = { id: randomUUID(), ...(about && { about }), ...(body.model && { model: body.model }), ...(body.effort && { effort: body.effort }), fork: null, state: 'thinking', activity: null, turns: [turn], at: now() };
      save(id, [...s.asides, opened]);
      void answer(id, opened.id, first, null).catch((err) => console.warn('aside failed', opened.id, err));
      return opened.id;
    }
    if (aside.state === 'thinking') throw new Error('wait for the answer before asking again');
    change(id, aside.id, (a) => ({ ...a, state: 'thinking', activity: null, turns: [...a.turns, turn], at: now() }));
    // A first answer that failed left no fork, so the question is put as a first one again.
    void answer(id, aside.id, aside.fork ? asidePrompt(question, false) : first, aside.fork).catch((err) => console.warn('aside failed', aside.id, err));
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

  // The asides about a round's questions go once that round is answered, dismissed or replaced.
  function sweep(all: readonly Session[]) {
    for (const s of all) {
      for (const a of s.asides) if (a.about && a.about.round !== s.round?.key) void close(s.id, a.id).catch((err) => console.warn('aside not closed', a.id, err));
    }
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

  return { ask, stop, close, drop, settle, sweep };
}
