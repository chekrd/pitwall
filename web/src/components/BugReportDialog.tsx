import { useRef, useState } from 'react';
import { fileBugReport, pitwallRepo } from '../bugReport.ts';
import { keepUnderLayer } from '../layers.ts';
import { record, snapshot } from '../recorder.ts';
import { useStore } from '../store.ts';
import styles from './BugReportDialog.module.css';
import { toast } from './Toasts.tsx';
import { explain, SENDS } from './explain.ts';
import { ModelPicker, useModelChoices } from './ModelPicker.tsx';

const DIALOG = 'bug-report';
const CHOICES = 'pitwall:bug-report-choices';

// The model and effort outlast the tab, as the next bug is usually fixed the way the last one was.
function storedChoices() {
  try {
    const { model = '', effort = '' } = JSON.parse(localStorage.getItem(CHOICES) ?? '{}') as { model?: string; effort?: string };
    return { model, effort };
  } catch {
    return { model: '', effort: '' };
  }
}
let taken: ReturnType<typeof snapshot> | null = null;

// The page is taken as it is before the dialog moves focus, so the report shows what was wrong, not the report.
export function openBugReport() {
  const dialog = document.getElementById(DIALOG) as HTMLDialogElement | null;
  if (!dialog || dialog.open) return;
  taken = snapshot();
  record('bug-report-open');
  dialog.showModal();
  dialog.querySelector('textarea')?.focus();
}

export function BugReportDialog() {
  const { sessions, repos, pitwall, link } = useStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const [comment, setComment] = useState('');
  const [{ model, effort }, setChoices] = useState(storedChoices);
  const repo = pitwallRepo(repos, pitwall);
  const choices = useModelChoices(repo ? `repo:${repo.id}` : 'repo:none', repo ? `/api/repos/${repo.id}/models` : null);
  const choose = (patch: { model?: string; effort?: string }) => {
    const next = { model, effort, ...patch };
    setChoices(next);
    try {
      localStorage.setItem(CHOICES, JSON.stringify(next));
    } catch {
      // A page without storage keeps them in memory only.
    }
  };

  const file = () => {
    const at = taken ?? snapshot();
    taken = null;
    dialog.current?.close();
    setComment('');
    void fileBugReport({ comment, model, effort, taken: at, sessions, repos, pitwall, link }).then((out) => {
      if (out.filed) toast('info', 'Filed the bug: a task reproduces it, fixes it and delivers the fix', { session: out.session ?? undefined });
      else toast('error', `Could not file the bug (${out.error}), so the report is saved to Downloads as ${out.file}`, { lasts: 15_000 });
    });
  };

  return (
    <dialog id={DIALOG} ref={dialog} closedby="any" aria-labelledby="bug-report-title" className={styles.dialog} onCancel={keepUnderLayer}>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          file();
        }}
      >
        <h2 id="bug-report-title">Bug report</h2>
        <textarea
          className={styles.comment}
          aria-label="What went wrong"
          placeholder="What went wrong? Optional"
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            file();
          }}
        />
        <p className={styles.hint}>
          A Pitwall task reproduces it, fixes it and delivers the fix, from what the board recorded in the last minutes and the page as it was a moment ago.
        </p>
        <div className={styles.foot}>
          <ModelPicker choices={choices} model={model} effort={effort} onChange={choose} />
          <button type="submit" className={styles.file} {...explain(SENDS.bugReport)}>
            File and fix <kbd>↵</kbd>
          </button>
        </div>
      </form>
    </dialog>
  );
}
