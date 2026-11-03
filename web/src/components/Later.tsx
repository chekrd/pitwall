import { useState, type KeyboardEvent } from 'react';
import { sessionAction } from '../api.ts';
import { active, type Request } from '../outbox.ts';
import { hold, useSends } from '../sends.ts';
import type { Parked, Session } from '../types.ts';
import { AsideList, askAside, canAsk, MAX_ASIDES } from './Asides.tsx';
import { explain, TIPS } from './explain.ts';
import styles from './Later.module.css';
import { toast } from './Toasts.tsx';

const reportError = (err: unknown) => toast('error', err instanceof Error ? err.message : String(err));

const park = (s: Session, action: 'park' | 'edit-park' | 'unpark', body: Record<string, unknown>) =>
  sessionAction(s.id, action, body).then(() => true, (err: unknown) => {
    reportError(err);
    return false;
  });

const short = (text: string) => (text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text);

// Every draft goes out as one message, held for 5 s with its Undo like any send, and leaves the task once it went out.
function sendNow(s: Session, drafts: readonly Parked[], name: string) {
  const text = drafts.map((d) => d.text).join('\n\n');
  const request: Request = { action: 'answer', body: { key: null, text, drafts: drafts.map((d) => d.id) }, label: text };
  void hold(s, request, name, { box: false });
}

// Enter does the field's job and Shift+Enter breaks the line, as in every other text field.
const onEnter = (run: () => void, cancel?: () => void) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key === 'Escape' && cancel) {
    e.preventDefault();
    e.stopPropagation();
    cancel();
  }
  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
  e.preventDefault();
  run();
};

function Item({ session, draft, name, canSend }: { session: Session; draft: Parked; name: string; canSend: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const save = () => {
    const text = editing?.trim();
    if (!text) return;
    if (text !== draft.text) void park(session, 'edit-park', { draft: draft.id, text });
    setEditing(null);
  };
  const remove = () => {
    void park(session, 'unpark', { draft: draft.id });
    toast('info', `Deleted the draft “${short(draft.text)}”`, {
      session: session.id,
      action: { label: 'Undo', run: () => void park(session, 'park', { text: draft.text, auto: draft.auto }) },
    });
  };
  return (
    <li className={styles.item} data-parked={draft.id}>
      {editing === null ? (
        <p className={styles.text}>{draft.text}</p>
      ) : (
        <textarea
          className={styles.field}
          aria-label="Edit the draft"
          value={editing}
          autoFocus
          onChange={(e) => setEditing(e.currentTarget.value)}
          onKeyDown={onEnter(save, () => setEditing(null))}
        />
      )}
      <div className={styles.actions}>
        <label {...explain(TIPS.auto, 'start', styles.auto)}>
          <input type="checkbox" checked={draft.auto} onChange={(e) => void park(session, 'edit-park', { draft: draft.id, auto: e.currentTarget.checked })} />
          Send when it's my turn
        </label>
        <span className={styles.spacer} />
        {editing === null ? (
          <>
            <button type="button" {...explain(TIPS.sendNow)} disabled={!canSend} onClick={() => sendNow(session, [draft], name)}>Send now</button>
            <button type="button" {...explain(TIPS.edit)} onClick={() => setEditing(draft.text)}>Edit</button>
            <button type="button" {...explain(TIPS.delete)} onClick={remove}>Delete</button>
          </>
        ) : (
          <>
            <button type="button" data-variant="primary" disabled={!editing.trim()} onClick={save}>Save</button>
            <button type="button" onClick={() => setEditing(null)}>Cancel</button>
          </>
        )}
      </div>
    </li>
  );
}

// One box for what comes to mind while Claude works: kept as a draft for the task's Claude, sent when you decide or when
// its turn ends, or asked on the side of a copy of the conversation that the task's Claude never sees.
export function Later({ session, name }: { session: Session; name: string }) {
  const [text, setText] = useState('');
  const [auto, setAuto] = useState(false);
  const sending = new Set(useSends().filter(active).flatMap((i) => (i.sessionId === session.id ? i.body.drafts ?? [] : [])));
  const drafts = session.parked.filter((d) => !sending.has(d.id));
  const canSend = session.status !== 'exited' && !session.archived;
  const take = (send: (t: string) => Promise<boolean>) => {
    const t = text.trim();
    if (!t) return;
    setText('');
    void send(t).then((ok) => {
      if (!ok) setText((now) => now || t);
    });
  };
  const add = () => take((t) => park(session, 'park', { text: t, auto }));
  const ask = () => take((t) => askAside(session, t));
  const asking = canAsk(session);
  const armed = drafts.filter((d) => d.auto).length;
  return (
    <section className={styles.later} data-later data-ux-section="later">
      <h3 className={styles.label} title="Drafts reach Claude only when you send them; a question asked on the side is answered by a copy of the conversation and never reaches it">
        Later {drafts.length > 0 && <span>· {drafts.length} {drafts.length === 1 ? 'draft' : 'drafts'}</span>}
        {session.asides.length > 0 && <span>· {session.asides.length} asked on the side</span>}
      </h3>
      {drafts.length > 0 && (
        <ul className={styles.list}>
          {drafts.map((d) => <Item key={d.id} session={session} draft={d} name={name} canSend={canSend} />)}
        </ul>
      )}
      {drafts.length > 1 && (
        <div className={styles.all}>
          {armed > 0 && <span className={styles.hint}>{armed === drafts.length ? 'All go' : `${armed} go`} as one message when Claude ends its turn.</span>}
          <span className={styles.spacer} />
          <button type="button" {...explain(TIPS.sendAll)} disabled={!canSend} onClick={() => sendNow(session, drafts, name)}>Send all now, as one message</button>
        </div>
      )}
      <AsideList session={session} />
      {!session.archived && (
        <div className={styles.add}>
          <textarea
            className={styles.field}
            aria-label="A message for later"
            placeholder="A message for later, or a question to ask on the side; Claude's work goes on…"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={onEnter(add)}
          />
          <div className={styles.actions}>
            <label {...explain(TIPS.auto, 'start', styles.auto)}>
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.currentTarget.checked)} />
              Send when it's my turn
            </label>
            <span className={styles.spacer} />
            <button
              type="button"
              {...explain(asking ? TIPS.ask : { does: session.asides.length >= MAX_ASIDES ? `Close an aside first; a task keeps at most ${MAX_ASIDES}.` : 'Claude has no conversation to copy yet.' })}
              disabled={!text.trim() || !asking}
              onClick={ask}
            >
              Ask on the side
            </button>
            <button type="button" {...explain(TIPS.keep)} disabled={!text.trim()} onClick={add}>Keep for later <kbd>↵</kbd></button>
          </div>
        </div>
      )}
    </section>
  );
}
