import { useLayoutEffect, useRef, useState } from 'react';
import type { Session } from '../types.ts';
import parts from './Parts.module.css';
import styles from './TaskRail.module.css';

// What the task is for, beside every card, so a decision can be made without its Overview.
export function TaskRail({ session }: { session: Session }) {
  const goal = session.firstPrompt;
  return (
    <aside className={styles.rail} aria-label="The task" data-rail>
      {goal && (
        <section>
          <h3 className={parts.label}>Task</h3>
          <Goal key={goal} text={goal} />
        </section>
      )}
    </aside>
  );
}

function Goal({ text }: { text: string }) {
  const body = useRef<HTMLParagraphElement>(null);
  const [folded, setFolded] = useState(false);
  const [full, setFull] = useState(false);
  useLayoutEffect(() => {
    const el = body.current!;
    setFolded(el.scrollHeight > el.clientHeight);
  }, []);
  return (
    <>
      <p ref={body} className={styles.goal} data-full={full || undefined} data-goal>{text}</p>
      {folded && <button type="button" className={parts.tiny} onClick={() => setFull(!full)}>{full ? 'Show less' : 'Show all'}</button>}
    </>
  );
}
