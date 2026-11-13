import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { sessionAction } from '../api.ts';
import type { ActionBody, Aside, Session } from '../types.ts';
import styles from './Asides.module.css';
import { explain, TIPS } from './explain.ts';
import { Markdown } from './Markdown.tsx';
import { effortName, modelName } from '../util.ts';
import { toast } from './Toasts.tsx';

const act = <A extends 'ask-aside' | 'stop-aside' | 'close-aside' | 'park'>(s: Session, action: A, body: ActionBody<A>) =>
  sessionAction(s.id, action, body).then(() => true, (err: unknown) => {
    toast('error', err instanceof Error ? err.message : String(err), { session: s.id });
    return false;
  });

export const MAX_ASIDES = 10;

// An aside about a question of a round shows with that question, and is not one of the task's ten.
export const ownAsides = (s: Session) => s.asides.filter((a) => !a.about);

export const canAsk = (s: Session) => !s.archived && s.lastTurn !== null && ownAsides(s).length < MAX_ASIDES;

export const askAside = (s: Session, text: string, aside: string | null = null, pick: { model?: string; effort?: string } = {}) =>
  act(s, 'ask-aside', { text, aside, ...(pick.model && { model: pick.model }), ...(pick.effort && { effort: pick.effort }) });

export const discuss = (s: Session, about: NonNullable<Aside['about']>, text: string) => act(s, 'ask-aside', { text, about });

function FollowUp({ session, aside, label, placeholder }: { session: Session; aside: string | null; label: string; placeholder: string }) {
  const [text, setText] = useState('');
  const ask = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    void askAside(session, t, aside).then((ok) => {
      if (!ok) setText((now) => now || t);
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    ask();
  };
  return (
    <div className={styles.ask}>
      <textarea className={styles.field} aria-label={label} placeholder={placeholder} value={text} onChange={(e) => setText(e.currentTarget.value)} onKeyDown={onKeyDown} />
      <button type="button" {...explain(TIPS.followUp)} disabled={!text.trim()} onClick={ask}>Ask <kbd>↵</kbd></button>
    </div>
  );
}

// One aside: its questions and answers, a follow-up field once it answered, and what can be done with it; `children`
// are the actions on its last answer.
export function AsideCard({ session, aside, as: Tag = 'li', children }: { session: Session; aside: Aside; as?: 'li' | 'div'; children?: ReactNode }) {
  const last = aside.turns.at(-1)!;
  return (
    <Tag className={styles.aside} data-aside={aside.id} data-state={aside.state}>
      {aside.turns.map((t, i) => (
        <div key={i} className={styles.turn}>
          <p className={styles.question}>{t.question}</p>
          {t.answer && <div className={styles.answer}><Markdown source={t.answer} /></div>}
          {t.error && <p className={styles.error}>No answer: {t.error}</p>}
        </div>
      ))}
      {aside.state === 'thinking' ? (
        <div className={styles.thinking}>
          <span className={styles.spinner} aria-hidden />
          <span>{aside.activity ?? 'A copy of the conversation is answering…'}</span>
          <span className={styles.spacer} />
          <button type="button" {...explain(TIPS.stop)} onClick={() => void act(session, 'stop-aside', { aside: aside.id })}>Stop</button>
        </div>
      ) : (
        <FollowUp session={session} aside={aside.id} label="A follow-up question" placeholder="A follow-up, in the same copy…" />
      )}
      <div className={styles.actions}>
        {last.answer && aside.state !== 'thinking' && children}
        <span className={styles.spacer} />
        {(aside.model || aside.effort) && (
          <span className={styles.on} data-aside-model data-explain="Picked for this question in place of the task's own; its follow-ups run on it too">
            {[aside.model && modelName(aside.model), aside.effort && `${effortName(aside.effort)} effort`].filter(Boolean).join(' · ')}
          </span>
        )}
        <button type="button" {...explain(TIPS.close)} onClick={() => void act(session, 'close-aside', { aside: aside.id })}>Close</button>
      </div>
    </Tag>
  );
}

function One({ session, aside }: { session: Session; aside: Aside }) {
  const keep = () => {
    const answer = aside.turns.at(-1)?.answer;
    if (!answer) return;
    void act(session, 'park', { text: answer }).then((ok) => ok && toast('info', 'The answer is a draft under Later now; edit it before you send it', { session: session.id }));
  };
  return (
    <AsideCard session={session} aside={aside}>
      <button type="button" {...explain(TIPS.keepAnswer)} onClick={keep}>Keep as a draft</button>
    </AsideCard>
  );
}

// Questions answered by a copy of the task's conversation, made when you ask: it knows all the task knows up to then,
// reads but changes nothing, and the task's Claude never sees the question.
export function AsideList({ session }: { session: Session }) {
  const asides = ownAsides(session);
  if (!asides.length) return null;
  return (
    <ul className={styles.list} data-asides aria-label="Asked on the side">
      {asides.map((a) => <One key={a.id} session={session} aside={a} />)}
    </ul>
  );
}
