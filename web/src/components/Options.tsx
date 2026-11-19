import type { QuestionOption } from '../types.ts';
import styles from './Options.module.css';
import parts from './Parts.module.css';

// Claude's options, in its order: each sends itself when pressed. The one Claude recommends is what ⏎ sends, and is
// highlighted.
export function Options({ options, onPick }: { options: readonly QuestionOption[]; onPick: (label: string) => void }) {
  if (!options.length) return null;
  const chosen = options.find((o) => o.recommended)?.label;
  return (
    <div className={styles.options} role="group" aria-label="Claude's options">
      <div className={styles.head}>
        <h3 className={parts.label}>Claude's options</h3>
        <span className={styles.order}>in the order Claude gave them, not ranked</span>
      </div>
      {options.map((o, i) => (
        <div key={o.label} className={styles.option} data-enter={o.label === chosen || undefined}>
          <button type="button" className={styles.button} data-option={i + 1} onClick={() => onPick(o.label)}>
            <span className={styles.badge}>{i + 1}</span>
            <span className={styles.text}>
              <span className={styles.label}>{o.label}</span>
              {o.description && <span className={styles.description}>{o.description}</span>}
            </span>
            <span className={styles.tags}>
              {o.recommended && <span className={parts.tag} data-quiet data-explain="Claude marked this option as the one it would choose">Claude recommends</span>}
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
