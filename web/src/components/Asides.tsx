import { useState, type KeyboardEvent } from 'react';
import { sessionAction } from '../api.ts';
import type { Aside, Session } from '../types.ts';
import styles from './Asides.module.css';
import { explain, TIPS } from './explain.ts';
import { Markdown } from './Markdown.tsx';
import { toast } from './Toasts.tsx';

const act = (s: Session, action: 'ask-aside' | 'stop-aside' | 'close-aside' | 'park', body: Record<string, unknown>) =>
  sessionAction(s.id, action, body).then(() => true, (err: unknown) => {
    toast('error', err instanceof Error ? err.message : String(err), { session: s.id });
    return false;
  });

export const MAX_ASIDES = 10;

export const canAsk = (s: Session) => !s.archived && s.lastTurn !== null && s.asides.length < MAX_ASIDES;

export const askAside = (s: Session, text: string, aside: string | null = null) => act(s, 'ask-aside', { text, aside });

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

function One({ session, aside }: { session: Session; aside: Aside }) {
  const last = aside.turns.at(-1)!;
  const keep = () => {
    if (!last.answer) return;
    void act(session, 'park', { text: last.answer }).then((ok) => ok && toast('info', 'The answer is a draft under Later now; edit it before you send it', { session: session.id }));
  };
  return (
    <li className={styles.aside} data-aside={aside.id} data-state={aside.state}>
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
        {last.answer && aside.state !== 'thinking' && (
          <button type="button" {...explain(TIPS.keepAnswer)} onClick={keep}>Keep as a draft</button>
        )}
        <span className={styles.spacer} />
        <button type="button" {...explain(TIPS.close)} onClick={() => void act(session, 'close-aside', { aside: aside.id })}>Close</button>
      </div>
    </li>
  );
}

// Questions answered by a copy of the task's conversation, made when you ask: it knows all the task knows up to then,
// reads but changes nothing, and the task's Claude never sees the question.
export function AsideList({ session }: { session: Session }) {
  if (!session.asides.length) return null;
  return (
    <ul className={styles.list} data-asides aria-label="Asked on the side">
      {session.asides.map((a) => <One key={a.id} session={session} aside={a} />)}
    </ul>
  );
}
