import type { KeyboardEvent } from 'react';
import type { Menu, MenuAnswer } from '../types.ts';
import styles from './MenuBody.module.css';
import parts from './Parts.module.css';

interface MenuBodyProps {
  menu: Menu;
  picks: readonly MenuAnswer[];
  onPick: (question: number, label: string) => void;
  onOther: (question: number, text: string) => void;
  // Enter in an own answer sends the menu once every question has an answer.
  onSubmit: () => void;
}

// Claude's AskUserQuestion menu: its questions side by side, options numbered across them so 1–9 reach each.
export function MenuBody({ menu, picks, onPick, onOther, onSubmit }: MenuBodyProps) {
  const onOtherKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    onSubmit();
  };
  let n = 0;
  return (
    <div className={styles.questions}>
      {menu.questions.map((q, i) => (
        <section key={i} className={styles.question} role="group" aria-label={`${q.header}${q.multiSelect ? ', pick any' : ''}`}>
          <div className={styles.header}>
            <span className={parts.label}>{q.header}</span>
            {q.multiSelect && <span className={styles.any}>pick any</span>}
          </div>
          <h2>{q.question}</h2>
          {q.options.map((o) => {
            n++;
            return (
              <button
                key={o.label}
                type="button"
                className={styles.option}
                data-option={n}
                data-multi={q.multiSelect || undefined}
                aria-pressed={picks[i]?.labels.includes(o.label) ?? false}
                onClick={() => onPick(i, o.label)}
              >
                <span className={styles.badge}>{n}</span>
                <span className={styles.text}>
                  <span className={styles.label}>{o.label}</span>
                  {o.description && <span className={styles.description}>{o.description}</span>}
                </span>
              </button>
            );
          })}
          {!q.multiSelect && (
            <input
              className={styles.other}
              placeholder="Or write your own answer…"
              aria-label={`Your own answer: ${q.header}`}
              value={picks[i]?.other ?? ''}
              onChange={(e) => onOther(i, e.currentTarget.value)}
              onKeyDown={onOtherKey}
            />
          )}
        </section>
      ))}
    </div>
  );
}
