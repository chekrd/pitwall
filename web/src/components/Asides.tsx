import { useState, type KeyboardEvent } from 'react';
import { sessionAction } from '../api.ts';
import type { Aside, Session } from '../types.ts';
import styles from './Asides.module.css';
import { Markdown } from './Markdown.tsx';
import { toast } from './Toasts.tsx';

const act = (s: Session, action: 'ask-aside' | 'stop-aside' | 'close-aside' | 'park', body: Record<string, unknown>) =>
  sessionAction(s.id, action, body).then(() => true, (err: unknown) => {
    toast('error', err instanceof Error ? err.message : String(err), { session: s.id });
    return false;
  });

function Ask({ session, aside, label, placeholder }: { session: Session; aside: string | null; label: string; placeholder: string }) {
  const [text, setText] = useState('');
  const ask = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    void act(session, 'ask-aside', { text: t, aside }).then((ok) => {
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
      <button type="button" disabled={!text.trim()} onClick={ask}>Ask <kbd>↵</kbd></button>
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
          <button type="button" onClick={() => void act(session, 'stop-aside', { aside: aside.id })}>Stop</button>
        </div>
      ) : (
        <Ask session={session} aside={aside.id} label="A follow-up question" placeholder="A follow-up, in the same copy…" />
      )}
      <div className={styles.actions}>
        {last.answer && aside.state !== 'thinking' && (
          <button type="button" title="Keep the answer as a draft under Later, to tell Claude when you decide" onClick={keep}>Keep as a draft</button>
        )}
        <span className={styles.spacer} />
        <button type="button" title="Forget this question and the copy of the conversation that answered it" onClick={() => void act(session, 'close-aside', { aside: aside.id })}>Close</button>
      </div>
    </li>
  );
}

// Questions answered by a copy of the task's conversation, made when you ask: it knows all the task knows up to then,
// reads but changes nothing, and the task's Claude never sees the question.
export function Asides({ session }: { session: Session }) {
  const canAsk = !session.archived && session.lastTurn !== null;
  if (!canAsk && !session.asides.length) return null;
  return (
    <section className={styles.asides} data-asides data-ux-section="asides">
      <h3 className={styles.label} title="Asked in a copy of the conversation, which reads but changes nothing; the task's Claude never sees it">
        Ask on the side {session.asides.length > 0 && <span>· {session.asides.length}</span>}
      </h3>
      {session.asides.length > 0 && (
        <ul className={styles.list}>
          {session.asides.map((a) => <One key={a.id} session={session} aside={a} />)}
        </ul>
      )}
      {canAsk && session.asides.length < 10 && (
        <Ask session={session} aside={null} label="A question on the side" placeholder="A question for a copy of this conversation; Claude's work goes on…" />
      )}
    </section>
  );
}
