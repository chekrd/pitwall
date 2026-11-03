import { useState, type KeyboardEvent } from 'react';
import { sessionAction } from '../api.ts';
import { active, type Request } from '../outbox.ts';
import { hold, useSends } from '../sends.ts';
import type { Parked, Session } from '../types.ts';
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
        <label className={styles.auto} title="Sent by itself when Claude ends its turn, unless you have replied by then, it ended on a question, or the task is paused or archived">
          <input type="checkbox" checked={draft.auto} onChange={(e) => void park(session, 'edit-park', { draft: draft.id, auto: e.currentTarget.checked })} />
          Send when it's my turn
        </label>
        <span className={styles.spacer} />
        {editing === null ? (
          <>
            <button type="button" disabled={!canSend} onClick={() => sendNow(session, [draft], name)}>Send now</button>
            <button type="button" onClick={() => setEditing(draft.text)}>Edit</button>
            <button type="button" onClick={remove}>Delete</button>
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

// Messages written while Claude works, kept on the task until you send them. Nothing here reaches Claude by itself,
// except a draft set to go when its turn ends.
export function Later({ session, name }: { session: Session; name: string }) {
  const [text, setText] = useState('');
  const [auto, setAuto] = useState(false);
  const sending = new Set(useSends().filter(active).flatMap((i) => (i.sessionId === session.id ? i.body.drafts ?? [] : [])));
  const drafts = session.parked.filter((d) => !sending.has(d.id));
  const canSend = session.status !== 'exited' && !session.archived;
  const add = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    void park(session, 'park', { text: t, auto }).then((ok) => {
      if (!ok) setText((now) => now || t);
    });
  };
  const armed = drafts.filter((d) => d.auto).length;
  return (
    <section className={styles.later} data-later data-ux-section="later">
      <h3 className={styles.label} title="Messages you write now and send to Claude when you decide; they do not reach Claude until then">
        Later {drafts.length > 0 && <span>· {drafts.length} {drafts.length === 1 ? 'draft' : 'drafts'}</span>}
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
          <button type="button" disabled={!canSend} onClick={() => sendNow(session, drafts, name)}>Send all now, as one message</button>
        </div>
      )}
      {!session.archived && (
        <div className={styles.add}>
          <textarea
            className={styles.field}
            aria-label="A message for later"
            placeholder="A message for later; Claude sees it only when you send it…"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={onEnter(add)}
          />
          <div className={styles.actions}>
            <label className={styles.auto}>
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.currentTarget.checked)} />
              Send when it's my turn
            </label>
            <span className={styles.spacer} />
            <button type="button" disabled={!text.trim()} onClick={add}>Keep for later <kbd>↵</kbd></button>
          </div>
        </div>
      )}
    </section>
  );
}
