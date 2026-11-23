import { useEffect, useRef, useState, type RefObject } from 'react';
import type { NewCycle } from '../../../server/cycles.ts';
import { rpiInvocation } from '../../../server/slash.ts';
import { api } from '../api.ts';
import { keepUnderLayer } from '../layers.ts';
import { hold } from '../sends.ts';
import { useStore } from '../store.ts';
import type { Session } from '../types.ts';
import { AttachButton, AttachedFiles, editDraft, readyPaths, takesFiles, uploading, useCommands, useDraft } from './Composer.tsx';
import { explain, SENDS } from './explain.ts';
import styles from './NewCycleDialog.module.css';
import { sendBlocked } from './PhaseSteps.tsx';

const DIALOG = 'new-cycle';
const SHOWN_CHANGES = 12;

type Check = { state: 'checking' } | { state: 'done'; cycle: NewCycle } | { state: 'failed'; error: string };

let ask: ((session: Session, name: string) => void) | null = null;

export const askNewCycle = (session: Session, name: string) => ask?.(session, name);

// The request is a draft of its own per task, so a send taken back with Undo brings it back here.
export const cycleDraft = (session: string) => `cycle:${session}`;

// Another rpi cycle in the same task, worktree and branch: the request goes as New task would send it, after a /clear,
// in a task directory of its own. Uncommitted changes are listed first, as the new cycle starts on top of them.
export function NewCycleDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [target, setTarget] = useState<{ id: string; name: string; check: Check } | null>(null);

  useEffect(() => {
    ask = (session, name) => {
      setTarget({ id: session.id, name, check: { state: 'checking' } });
      const settle = (check: Check) => setTarget((t) => (t?.id === session.id ? { ...t, check } : t));
      api('GET', `/api/sessions/${session.id}/new-cycle`).then((cycle) => settle({ state: 'done', cycle }), (err: Error) => settle({ state: 'failed', error: err.message }));
      if (!dialog.current!.open) dialog.current!.showModal();
    };
    return () => {
      ask = null;
    };
  }, []);

  return (
    <dialog id={DIALOG} ref={dialog} closedby="any" aria-labelledby="new-cycle-title" className={styles.dialog} onCancel={keepUnderLayer} onClose={() => setTarget(null)}>
      {target && <CycleForm key={target.id} id={target.id} name={target.name} check={target.check} field={field} close={() => dialog.current?.close()} />}
    </dialog>
  );
}

function CycleForm({ id, name, check, field, close }: { id: string; name: string; check: Check; field: RefObject<HTMLTextAreaElement | null>; close: () => void }) {
  const { sessions } = useStore();
  const session = sessions.find((s) => s.id === id);
  const commands = useCommands(session?.worktree ?? '', !!session);
  const box = cycleDraft(id);
  const draft = useDraft(box);
  const refocus = () => field.current?.focus();
  useEffect(refocus, []);
  const { onPaste, onDragOver, onDrop } = takesFiles(box, refocus);
  const cycle = check.state === 'done' ? check.cycle : null;
  const changes = cycle?.changes ?? [];
  const blocked = session ? sendBlocked(session, commands) : 'The task is gone from the board.';
  const empty = !draft.text.trim() && !readyPaths(draft).length;
  const invocation = rpiInvocation(commands ?? []);
  const folder = cycle?.folder ?? '…';
  const first = draft.text.trim().split('\n')[0];
  const command = `${invocation} ${first ? `${first}; ` : ''}task directory: ${folder}`;

  const send = () => {
    if (!session || blocked || empty || uploading(draft) || check.state === 'checking') return;
    close();
    void hold(session, {
      action: 'answer', body: { key: null, text: draft.text, files: readyPaths(draft), cycle: true }, label: `/clear, then ${command}`, command: true,
    }, name, { from: box });
  };

  return (
    <form
      className={styles.form}
      onPaste={onPaste}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <h2 id="new-cycle-title">New RPI cycle</h2>
      <AttachedFiles id={box} refocus={refocus} />
      <div className={styles.promptRow}>
        <textarea
          ref={field}
          className={styles.prompt}
          rows={1}
          aria-label="What should the new cycle work on?"
          placeholder="What should the new cycle work on?"
          value={draft.text}
          data-cycle-request
          onChange={(e) => {
            const text = e.currentTarget.value;
            editDraft(box, (d) => ({ ...d, text }));
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing) return;
            e.preventDefault();
            send();
          }}
        />
        <AttachButton id={box} refocus={refocus} />
      </div>
      <p className={styles.hint} data-cycle-hint>
        Sends <code>/clear</code>, then rpi on the request in the same worktree and branch, with its documents in <code>{folder}</code>. The documents of earlier cycles stay
        where they are, under Earlier cycles in Documents.
      </p>
      {check.state === 'checking' && <p className={styles.muted}>Checking the worktree for uncommitted changes…</p>}
      {check.state === 'failed' && <p className={styles.warning} role="alert">Could not read the worktree ({check.error}).</p>}
      {changes.length > 0 && (
        <div className={styles.changes} data-uncommitted>
          <p className={styles.warning}>The worktree has uncommitted changes, which the new cycle starts on top of:</p>
          <ul>
            {changes.slice(0, SHOWN_CHANGES).map((f) => <li key={f}><code>{f}</code></li>)}
            {changes.length > SHOWN_CHANGES && <li className={styles.muted}>and {changes.length - SHOWN_CHANGES} more</li>}
          </ul>
        </div>
      )}
      <footer className={styles.foot}>
        <button type="button" onClick={close}>Cancel</button>
        <button
          type="submit"
          className={styles.start}
          data-start-cycle
          disabled={!!blocked || empty || uploading(draft) || check.state === 'checking'}
          {...explain(blocked ? { does: blocked } : { ...SENDS.prompt(`/clear”, then, once Claude has started the new conversation, “${command}`), sees: 'a new conversation: /clear leaves this one behind' })}
        >
          {changes.length ? 'Continue anyway' : 'Start cycle'} <kbd>⌘↵</kbd>
        </button>
      </footer>
    </form>
  );
}
