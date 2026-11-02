import { useEffect, useState } from 'react';
import styles from './CopyButton.module.css';
import { Icon } from './Icon.tsx';
import { toast } from './Toasts.tsx';

const COPIED_MS = 1500;

export function useCopy(value: string, what: string) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => navigator.clipboard.writeText(value).then(
    () => setCopied(true),
    () => toast('error', `Could not copy the ${what.toLowerCase()}`),
  );
  return { copied, copy };
}

// Shows while the message it sits in is hovered. Its name is a tooltip of the board's own, not a title, so the heading
// it sits in keeps its text.
export function CopyButton({ value, what }: { value: string; what: string }) {
  const { copied, copy } = useCopy(value, what);
  return (
    <button
      type="button"
      className={styles.copy}
      data-ux={`copy ${what.toLowerCase()}`}
      data-copied={copied || undefined}
      data-tip={copied ? 'Copied' : `Copy ${what.toLowerCase()}`}
      aria-label={`Copy ${what.toLowerCase()}`}
      title=""
      onClick={() => void copy()}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
      <span className={styles.status} aria-live="polite">{copied ? 'Copied' : ''}</span>
    </button>
  );
}
