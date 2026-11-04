import { useEffect, useState } from 'react';
import { decisionKey } from '../../server/decision.ts';
import { freeze, startPicks, togglePick } from './deck.ts';
import { queue, useQueue } from './queue.ts';
import type { Menu, MenuAnswer, Session } from './types.ts';

// State that belongs to one decision: a new decision on the same card starts it afresh.
export function useKeyed<T>(key: string | null, initial: () => T): [T, (value: T) => void] {
  const [state, setState] = useState(() => ({ key, value: initial() }));
  const current = state.key === key ? state : { key, value: initial() };
  if (current !== state) setState(current);
  return [current.value, (value: T) => setState({ key, value })];
}

// What a decision's card and its task page share: the choice frozen when the decision first showed, which a later
// second opinion does not move, and a menu's picks, which belong to that one menu, so a menu that replaces it in the
// same snapshot starts with its own.
export function useDecision(session: Session, menu: Menu | null) {
  const q = useQueue();
  const key = decisionKey(session);
  const frozen = key ? (q.frozen.get(key) ?? freeze(session)) : null;
  const [picks, showPicks] = useKeyed<MenuAnswer[]>(key, () => startPicks(key ? queue.picksOf(key) : null, frozen));
  const setPicks = (value: MenuAnswer[]) => {
    showPicks(value);
    if (key) queue.pick(key, value);
  };

  useEffect(() => {
    if (key && frozen) queue.freeze(key, frozen);
  }, [key, frozen]);

  // The compiler reads what a callback uses during render, so a `menu!.questions` there would throw without a menu.
  const questions = menu?.questions ?? [];
  // A menu of one single-choice question answers with the pick, as the terminal does.
  const lone = questions.length === 1 && !questions[0].multiSelect;
  const toggle = (question: number, label: string) => setPicks(togglePick(picks, question, label, questions[question]?.multiSelect === true));
  // An own answer to a question replaces its picks.
  const answerOwn = (question: number, other: string) => setPicks(picks.map((p, i) => (i === question ? { labels: other ? [] : p.labels, other } : p)));
  return { key, frozen, picks, setPicks, toggle, answerOwn, questions, lone };
}
