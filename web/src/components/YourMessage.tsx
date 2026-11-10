import { lineOf } from '../dock.ts';
import { useNow } from '../now.ts';
import type { Item } from '../outbox.ts';
import { HOLD_MS, undo, useSends } from '../sends.ts';
import type { Session } from '../types.ts';
import { clock } from '../util.ts';
import { Said } from './LatestReply.tsx';
import styles from './YourMessage.module.css';

const UNCONFIRMED: ReadonlySet<string> = new Set(['held', 'sending', 'waiting', 'sent']);

// The message this page is sending to the task, from the press until a snapshot shows that it took.
export function useSending(session: Session) {
  return useSends().findLast((i) => i.sessionId === session.id && !i.command && UNCONFIRMED.has(i.state) && (i.action === 'answer' || i.action === 'accept-advice')) ?? null;
}

const sendingText = (i: Item) => [i.body.choice, i.body.text].filter(Boolean).join(' — ') || i.label;

// What you wrote last and Claude has not replied to: the trigger of the turn under way.
export const waitingText = (session: Session, send: Item | null) => (send ? sendingText(send) : session.unanswered?.text ?? null);

function Countdown({ session, send }: { session: Session; send: Item }) {
  return <>{lineOf({ session, state: 'held', send }, useNow(), HOLD_MS)}</>;
}

function claudeLine(session: Session) {
  if (session.unanswered?.queued) return 'Queued: Claude reads it once its current step ends';
  if (session.status === 'working') return session.activity?.between ? 'Claude waits on background work' : `Claude is working${session.activity?.step ? ` · ${session.activity.step}` : ''}`;
  if (session.status === 'exited') return 'Claude ended without replying';
  return session.status === 'idle' ? 'No reply yet' : null;
}

// Your latest message from the moment you send it until Claude replies to it: first as this page sends it, with its
// Undo, then as Claude's transcript has it, with what Claude is doing about it.
export function YourMessage({ session, send }: { session: Session; send: Item | null }) {
  const text = waitingText(session, send);
  if (text === null) return null;
  const line = send ? null : claudeLine(session);
  const busy = !send && session.status === 'working' && !session.unanswered?.queued;
  return (
    <section className={styles.message} data-your-message={send?.state ?? (session.unanswered?.queued ? 'queued' : 'unanswered')} data-ux-section="your message">
      <h3>
        Your latest message
        <span className={styles.when} data-when aria-live="polite">
          {send?.state === 'held' ? <Countdown session={session} send={send} /> : send ? lineOf({ session, state: 'sent', send }, 0, HOLD_MS) : `Sent ${clock(session.unanswered!.at)}`}
        </span>
        {send?.state === 'held' && <button type="button" className={styles.undo} data-explain="Take the message back into the reply box" onClick={() => undo(send.id)}>Undo</button>}
      </h3>
      <Said key={text} text={text} />
      {line && <p className={styles.claude} data-claude data-busy={busy || undefined}>{busy && <span className={styles.spinner} aria-hidden />}<span>{line}</span></p>}
    </section>
  );
}
