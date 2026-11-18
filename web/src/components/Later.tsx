import { useState, type KeyboardEvent } from 'react';
import { editDraft, useDraft } from './Composer.tsx';
import { draftMessage, refLines } from '../../../server/codeRef.ts';
import { sessionAction } from '../api.ts';
import { active, type Request } from '../outbox.ts';
import { hold, useSends } from '../sends.ts';
import { useStore } from '../store.ts';
import type { ActionBody, CodeRef, Parked, Session } from '../types.ts';
import { AsideList, askAside, canAsk, MAX_ASIDES, ownAsides } from './Asides.tsx';
import { explain, TIPS, type Explanation } from './explain.ts';
import { ModelPicker, useModelChoices, useStoredPick } from './ModelPicker.tsx';
import styles from './Later.module.css';
import { toast } from './Toasts.tsx';

const reportError = (err: unknown) => toast('error', err instanceof Error ? err.message : String(err));

export const park = <A extends 'park' | 'edit-park' | 'unpark'>(s: Session, action: A, body: ActionBody<A>) =>
  sessionAction(s.id, action, body).then(() => true, (err: unknown) => {
    reportError(err);
    return false;
  });

const ASIDE_TIPS = {
  model: 'The model the copy that answers a question asked on the side runs on; the first is the task\'s own. Drafts go to the task\'s Claude on its model',
  effort: 'How hard the copy that answers a question asked on the side thinks; the first is the task\'s own',
};

const short = (text: string) => (text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text);

// Every draft goes out as one message, each with the lines it was written about, held for 5 s with its Undo like any
// send, and leaves the task once it went out.
function sendNow(s: Session, drafts: readonly Parked[], name: string) {
  const text = drafts.map(draftMessage).join('\n\n');
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

function Lines({ at }: { at: CodeRef }) {
  const count = at.end - at.start + 1;
  return (
    <figure className={styles.ref} data-ref data-explain="The lines of the diff this draft is about; Claude gets them with it">
      <figcaption>
        <code>{at.path}</code> {refLines(at)}{at.side === 'old' && ', as the base branch has them'}
      </figcaption>
      {at.lines.length > 0 && (
        <pre>
          {at.lines.map((l, i) => (
            <span key={i}><span className={styles.num}>{at.start + i}</span>{l}{'\n'}</span>
          ))}
          {at.lines.length < count && <span className={styles.num}>… {count - at.lines.length} more</span>}
        </pre>
      )}
    </figure>
  );
}

function Item({ session, draft, name, canSend, sendTip }: { session: Session; draft: Parked; name: string; canSend: boolean; sendTip: Explanation }) {
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
      action: { label: 'Undo', run: () => void park(session, 'park', { text: draft.text, auto: draft.auto, ...(draft.ref && { ref: draft.ref }) }) },
    });
  };
  return (
    <li className={styles.item} data-parked={draft.id}>
      {draft.ref && <Lines at={draft.ref} />}
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
        <label className={styles.auto} {...explain(TIPS.auto)}>
          <input type="checkbox" checked={draft.auto} onChange={(e) => void park(session, 'edit-park', { draft: draft.id, auto: e.currentTarget.checked })} />
          Send when it's my turn
        </label>
        <span className={styles.spacer} />
        {editing === null ? (
          <>
            <button type="button" {...explain(sendTip)} disabled={!canSend} onClick={() => sendNow(session, [draft], name)}>Send now</button>
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

// The buttons under Message Claude that keep its text instead of sending it: as a draft for the task's Claude, sent when
// you decide or when its turn ends, or asked on the side of a copy of the conversation that the task's Claude never sees.
export function LaterActions({ session }: { session: Session }) {
  const draft = useDraft(session.id);
  const [pick, choose] = useStoredPick('pitwall:aside-choices');
  // A task across a folder runs in <folder>/worktrees/<task>, and the folder's settings are the ones it reads.
  const folder = useStore().folders.find((f) => session.repoId === null && session.worktree.startsWith(`${f.path}/worktrees/`));
  const choices = useModelChoices(
    session.repoId !== null ? `repo:${session.repoId}` : `folder:${folder?.path}`,
    session.repoId !== null ? `/api/repos/${session.repoId}/models` : folder ? `/api/folders/models?path=${encodeURIComponent(folder.path)}` : null,
  );
  // A draft and a question are text only; files attached go with a message sent now.
  const ready = !!draft.text.trim() && !draft.files.length;
  const take = (send: (t: string) => Promise<boolean>) => {
    const t = draft.text.trim();
    if (!t) return;
    editDraft(session.id, (d) => ({ ...d, text: '' }));
    void send(t).then((ok) => {
      if (!ok) editDraft(session.id, (d) => (d.text ? d : { ...d, text: t }));
    });
  };
  const asking = canAsk(session);
  const asides = ownAsides(session).length;
  const files = draft.files.length > 0 ? { does: 'Takes text only; send the files with Enter, or remove them first.' } : null;
  return (
    <div className={styles.actions} data-later-actions>
      <div className={styles.group}>
        <ModelPicker choices={choices} current={session} model={pick.model} effort={pick.effort} onChange={choose} tips={ASIDE_TIPS} />
        <button
          type="button"
          {...explain(files ?? (asking ? TIPS.ask : { does: asides >= MAX_ASIDES ? `Close an aside first; a task keeps at most ${MAX_ASIDES}.` : 'Claude has no conversation to copy yet.' }))}
          disabled={!ready || !asking}
          onClick={() => take((t) => askAside(session, t, null, pick))}
        >
          Ask on the side
        </button>
      </div>
      <div className={styles.group} data-keep>
        <button type="button" {...explain(files ?? TIPS.autoKeep)} disabled={!ready} onClick={() => take((t) => park(session, 'park', { text: t, auto: true }))}>
          Send when it's my turn
        </button>
        <button type="button" {...explain(files ?? TIPS.keep)} disabled={!ready} onClick={() => take((t) => park(session, 'park', { text: t, auto: false }))}>
          Keep for later
        </button>
      </div>
    </div>
  );
}

// What was kept for later: the drafts, each sent when you decide or when the turn ends, and the questions asked on the side.
export function Later({ session, name }: { session: Session; name: string }) {
  const sending = new Set(useSends().filter(active).flatMap((i) => (i.sessionId === session.id ? i.body.drafts ?? [] : [])));
  const drafts = session.parked.filter((d) => !sending.has(d.id));
  // The server refuses typing while the terminal shows a question, which the message would answer.
  const asked = session.status === 'waiting' || !!session.menu;
  const canSend = session.status !== 'exited' && !session.archived && !asked;
  const armed = drafts.filter((d) => d.auto).length;
  const asides = ownAsides(session).length;
  if (!drafts.length && !asides) return null;
  return (
    <section className={styles.later} data-later data-ux-section="later">
      <h3 className={styles.label} data-explain="Drafts reach Claude only when you send them; a question asked on the side is answered by a copy of the conversation and never reaches it">
        Later {drafts.length > 0 && <span>· {drafts.length} {drafts.length === 1 ? 'draft' : 'drafts'}</span>}
        {asides > 0 && <span>· {asides} asked on the side</span>}
      </h3>
      {drafts.length > 0 && (
        <ul className={styles.list}>
          {drafts.map((d) => <Item key={d.id} session={session} draft={d} name={name} canSend={canSend} sendTip={asked ? TIPS.sendAsked : TIPS.sendNow} />)}
        </ul>
      )}
      {drafts.length > 1 && (
        <div className={styles.all}>
          {armed > 0 && <span className={styles.hint}>{armed === drafts.length ? 'All go' : `${armed} go`} as one message when Claude ends its turn.</span>}
          <span className={styles.spacer} />
          <button type="button" {...explain(asked ? TIPS.sendAsked : TIPS.sendAll)} disabled={!canSend} onClick={() => sendNow(session, drafts, name)}>Send all now, as one message</button>
        </div>
      )}
      <AsideList session={session} />
    </section>
  );
}
