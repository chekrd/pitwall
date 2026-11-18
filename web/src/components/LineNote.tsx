import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { refLines } from '../../../server/codeRef.ts';
import type { CodeRef, Session } from '../types.ts';
import { explain, TIPS } from './explain.ts';
import { park } from './Later.tsx';
import styles from './LineNote.module.css';
import { toast } from './Toasts.tsx';

// A draft written under lines picked in the diff. Enter keeps it for later, so nothing reaches Claude from here; it
// goes out from the Overview's Later list, or by itself when armed, with the lines it was written about.
export function LineNote({ session, at, onDone }: { session: Session; at: CodeRef; onDone: () => void }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  // The diff moves the annotation into its slot after React mounted it, which drops the focus autoFocus gave it.
  useEffect(() => {
    let frame = 0;
    const take = (tries: number) => {
      const el = field.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      if (document.activeElement !== el && tries > 0) frame = requestAnimationFrame(() => take(tries - 1));
    };
    take(10);
    return () => cancelAnimationFrame(frame);
  }, []);
  const keep = (auto: boolean) => {
    const t = text.trim();
    if (!t || saving) return;
    setSaving(true);
    void park(session, 'park', { text: t, auto, ref: at }).then((ok) => {
      setSaving(false);
      if (!ok) return;
      toast('info', auto ? `Goes to Claude when its turn ends, with ${at.path} ${refLines(at)}` : `Kept for later, with ${at.path} ${refLines(at)}`, { session: session.id });
      onDone();
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onDone();
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    keep(false);
  };
  return (
    <div className={styles.note} data-line-note>
      <p className={styles.where}>
        <code>{at.path}</code> {refLines(at)}{at.side === 'old' && ' (base branch)'}
      </p>
      <textarea
        className={styles.field}
        aria-label={`A draft about ${at.path} ${refLines(at)}`}
        placeholder="Write to Claude about these lines. Enter keeps it for later; Shift+Enter breaks the line."
        ref={field}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div className={styles.actions}>
        <button type="button" onClick={onDone} data-explain="Esc">Cancel</button>
        <span className={styles.spacer} />
        <button type="button" {...explain(TIPS.autoKeep)} disabled={!text.trim() || saving} onClick={() => keep(true)}>Send when it's my turn</button>
        <button type="button" data-variant="primary" {...explain(TIPS.keep)} disabled={!text.trim() || saving} onClick={() => keep(false)}>Keep for later</button>
      </div>
    </div>
  );
}
