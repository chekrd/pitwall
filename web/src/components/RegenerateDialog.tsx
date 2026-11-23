import { useEffect, useRef, useState } from 'react';
import { sessionAction } from '../api.ts';
import { useStore } from '../store.ts';
import type { Session } from '../types.ts';
import { tilde } from '../util.ts';
import styles from './RegenerateDialog.module.css';

let ask: ((session: Session) => void) | null = null;

export const askRegenerate = (session: Session) => ask?.(session);

// The dialog is the confirmation: the runs replace each picked main checkout's model, and nothing undoes that.
export function RegenerateDialog() {
  const { home, sessions } = useStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState<{ id: string; skipped: string[] } | null>(null);

  useEffect(() => {
    ask = (session) => setTarget({ id: session.id, skipped: [] });
    return () => {
      ask = null;
    };
  }, []);

  const asked = target?.id;
  useEffect(() => {
    if (asked && !dialog.current!.open) dialog.current!.showModal();
  }, [asked]);

  const regeneration = sessions.find((s) => s.id === target?.id)?.regeneration ?? null;
  const repos = regeneration?.repos ?? [];
  const running = (key: string) => !!regeneration?.running.includes(key);
  const chosen = repos.filter((r) => !running(r.key) && !target?.skipped.includes(r.key)).map((r) => r.key);

  const toggle = (key: string, on: boolean) =>
    setTarget((t) => t && { ...t, skipped: on ? t.skipped.filter((k) => k !== key) : [...t.skipped, key] });

  const confirm = () => {
    const id = target!.id;
    dialog.current!.close();
    sessionAction(id, 'regenerate-architecture', { repos: chosen }).catch(reportError);
  };

  return (
    <dialog id="regenerate-architecture" ref={dialog} aria-labelledby="regenerate-architecture-title" className={styles.dialog} onClose={() => setTarget(null)}>
      {target && (
        <>
          <h2 id="regenerate-architecture-title">Regenerate the architecture?</h2>
          <p>
            Opus reads the code of each repository you pick, in its main checkout, and writes its architecture model there afresh: the
            repository's own, as on its base branch, not this task's. This task's Claude is not interrupted.
          </p>
          {repos.length ? (
            <ul className={styles.repos} aria-label="Repositories">
              {repos.map((r) => (
                <li key={r.key}>
                  <label data-regenerate-repo={r.name}>
                    <input type="checkbox" checked={chosen.includes(r.key)} disabled={running(r.key)} onChange={(e) => toggle(r.key, e.target.checked)} />
                    <span className={styles.repo}>
                      <strong>{r.name}</strong>
                      <code>{tilde(`${r.main}/.pitwall/architecture`, home)}</code>
                      {running(r.key) && <span className={styles.muted} data-regenerating-note>Being regenerated now</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.muted}>This task has no repository with a main checkout any more.</p>
          )}
          <p className={styles.muted}>
            Each picked main checkout's model is replaced, and there is no Undo; none of it is in git. A worktree whose model is still the one
            replaced gets the new one; one with a task's own changes keeps them.
          </p>
          <footer>
            <button type="button" commandfor="regenerate-architecture" command="close" autoFocus>Cancel</button>
            <button type="button" data-variant="primary" data-regenerate-confirm disabled={!chosen.length} onClick={confirm}>Regenerate</button>
          </footer>
        </>
      )}
    </dialog>
  );
}
