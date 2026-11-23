import { useId } from 'react';
import { api, sessionAction } from '../api.ts';
import { closeSheetOf } from '../router.ts';
import { sends } from '../sends.ts';
import { patchSession, unpatch, useStore } from '../store.ts';
import type { ActionBody, ActionName, Regeneration, Session, WorktreeView } from '../types.ts';
import { tilde } from '../util.ts';
import { askDeleteWorktree } from './DeleteWorktreeDialog.tsx';
import { Icon } from './Icon.tsx';
import { askRegenerate } from './RegenerateDialog.tsx';
import styles from './SessionMenu.module.css';
import { toast, UNDO_KBD } from './Toasts.tsx';

const TYPED_MS = 2000;

// A held answer goes out first, and the terminal comes up once it is typed (or 2 s on), so it is never pasted into a
// terminal someone types in.
export async function openTerminal(id: string) {
  await Promise.race([sends.sendNow(id), new Promise((done) => setTimeout(done, TYPED_MS))]);
  return sessionAction(id, 'focus');
}

// The page shows the change before the server has it; when the request fails, the session shows as the server has it.
const failed = (id: string) => (err: unknown) => {
  unpatch(id);
  reportError(err);
};

// The task shows as archived at once, and Undo brings it back.
export function archive(session: Session, name: string) {
  const { id } = session;
  patchSession(id, { archived: true });
  sessionAction(id, 'archive', { archived: true }).then(() => {
    const undo = () => {
      patchSession(id, { archived: false, ...resumed(session) });
      sessionAction(id, 'archive', { archived: false }).catch(failed(id));
    };
    toast('undo', `Archived ${name}`, { session: id, action: { label: 'Undo', kbd: UNDO_KBD, run: undo } });
  }, failed(id));
}

// Archiving quit an idle or waiting Claude, which an Undo resumes waiting for you, so the task comes back as it left
// rather than as ended until the snapshot that has it running again.
const resumed = (session: Session): Partial<Session> => (session.status === 'idle' || session.status === 'waiting' ? { status: 'idle' } : {});

const quitNote = (session: Session) =>
  session.status === 'exited' ? '' : session.status === 'working' ? 'its Claude quits once this turn ends, and ' : 'its Claude quits, and ';

// Claude quits: the task shows as ended at once.
function quit(session: Session) {
  patchSession(session.id, { status: 'exited' });
  sessionAction(session.id, 'quit').catch(failed(session.id));
}

type Mark = { state: 'running' | 'failed'; text: string; note: string };

const names = (r: Regeneration, keys: string[]) => r.repos.filter((x) => keys.includes(x.key)).map((x) => x.name).join(', ');

// While a repository's architecture is being regenerated the item and the ⋯ button turn; once a run failed they show an
// icon that names its log, until the next run.
function regenerationMark(r: Regeneration | null | undefined, home: string): Mark | null {
  if (!r) return null;
  if (r.running.length) {
    const which = names(r, r.running);
    return { state: 'running', text: `Regenerating the architecture of ${which}`, note: `Opus is writing ${which}'s model in its main checkout` };
  }
  if (!r.failed.length) return null;
  const which = names(r, r.failed.map((f) => f.key));
  const logs = r.failed.map((f) => tilde(f.log, home)).join(', ');
  return { state: 'failed', text: `Regenerating the architecture of ${which} failed; an agent can read why in ${logs}`, note: `Failed for ${which}; its log says why` };
}

function RegenerationMark({ mark, corner = false }: { mark: Mark; corner?: boolean }) {
  return mark.state === 'running' ? (
    <span className={styles.spinner} data-corner={corner || undefined} data-regenerating role="img" aria-label={mark.text} />
  ) : (
    <span className={styles.failed} data-corner={corner || undefined} data-regeneration-failed role="img" aria-label={mark.text} data-explain={mark.text}>
      <Icon name="alert" size={corner ? 11 : 13} />
    </span>
  );
}

export function SessionMenu({ session, worktree, name }: { session: Session; worktree: WorktreeView | undefined; name: string }) {
  const id = useId();
  const exited = session.status === 'exited';
  const clearing = !!session.clearing;
  const { home } = useStore();
  const path = tilde(session.worktree, home);
  const regeneration = clearing ? null : session.regeneration;
  const mark = regenerationMark(regeneration, home);
  const pick = (run: () => unknown) => () => {
    document.getElementById(id)?.hidePopover();
    run();
  };
  const act = <A extends ActionName>(action: A, body: ActionBody<A>) => pick(() => sessionAction(session.id, action, body).catch(reportError));
  if (session.starting) return null;

  return (
    <>
      <button
        type="button"
        className={styles.more}
        popoverTarget={id}
        aria-label="Session actions"
        data-tip={mark ? undefined : 'More actions'}
        data-explain={mark ? `More actions. ${mark.text}` : undefined}
        data-regeneration={mark?.state}
      >
        <Icon name="more" size={18} />
        {mark && <RegenerationMark mark={mark} corner />}
      </button>
      <div id={id} popover="auto" className={styles.menu}>
        <Item label="Open in Ghostty" note={`New shell in ${tilde(session.cwd, home)}`} onClick={pick(() => api('POST', '/api/shell', { worktree: session.cwd }).catch(reportError))} />
        {clearing ? null : exited ? (
          <Item label="Continue" note="Resume the conversation in a hidden terminal" onClick={act('focus', {})} />
        ) : (
          <Item label="Open session in terminal" note="Show its terminal in Ghostty" onClick={pick(() => openTerminal(session.id).catch(reportError))} />
        )}
        <Item label="Open in Finder" note={path} onClick={act('finder', {})} />
        <Item label="Open in VS Code" note={path} onClick={act('vscode', {})} />
        {regeneration && (
          <Item
            label="Regenerate architecture…"
            note={mark?.note ?? (regeneration.repos.length > 1 ? "Opus writes each repository's model afresh, in its main checkout" : "Opus writes the repository's model afresh, in its main checkout")}
            mark={mark}
            onClick={pick(() => askRegenerate(session))}
          />
        )}
        {!exited && !clearing && (
          <Item
            label="Quit Claude"
            note="Stops the process; Continue picks it up later"
            onClick={pick(() => quit(session))}
          />
        )}
        {clearing ? null : session.archived ? (
          <Item label="Unarchive" note={exited ? 'Resume the conversation, back among the tasks on the Wall' : 'Back among the tasks on the Wall'} onClick={act('archive', { archived: false })} />
        ) : (
          <Item label="Archive" note={`Done with it: ${quitNote(session)}Unarchive resumes the conversation`} onClick={pick(() => archive(session, name))} />
        )}
        {exited && !clearing && (
          <Item
            label="Remove from list"
            note="The conversation and worktree stay"
            danger
            onClick={pick(() => {
              closeSheetOf(session.id);
              sessionAction(session.id, 'forget').catch(reportError);
            })}
          />
        )}
        {!clearing && (
          <Item
            label="Clear task…"
            note={!worktree ? 'Quits Claude and removes the task; its worktree is already gone' : worktree.isMain ? 'Quits Claude and removes the task; the checkout stays' : 'Quits Claude, deletes the worktree and its branch, removes the task'}
            danger
            onClick={pick(() => askDeleteWorktree(session))}
          />
        )}
      </div>
    </>
  );
}

function Item({ label, note, danger = false, mark = null, onClick }: { label: string; note: string; danger?: boolean; mark?: Mark | null; onClick: () => void }) {
  return (
    <button type="button" className={styles.item} data-ux={label} data-danger={danger || undefined} data-regeneration={mark?.state} onClick={onClick}>
      <span className={styles.label}>{label}{mark && <RegenerationMark mark={mark} />}</span>
      <span className={styles.note}>{note}</span>
    </button>
  );
}

// The same ask as the menu's Clear task…, a click closer; the dialog still says what would be lost.
export function ClearButton({ session }: { session: Session }) {
  if (session.clearing || session.starting) return null;
  return (
    <button type="button" className={styles.more} aria-label="Clear task" data-tip="Clear task…" data-clear onClick={() => askDeleteWorktree(session)}>
      <Icon name="trash" size={17} />
    </button>
  );
}

export function FocusButton({ session }: { session: Session }) {
  const exited = session.status === 'exited';
  const open = () => void (exited ? sessionAction(session.id, 'focus') : openTerminal(session.id)).catch(reportError);
  return (
    <button type="button" data-variant="primary" data-explain={exited ? 'Continue this conversation' : 'Show its terminal in Ghostty'} onClick={open}>
      {exited ? 'Continue' : 'Terminal'}
    </button>
  );
}
