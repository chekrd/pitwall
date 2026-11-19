import type { Request } from '../outbox.ts';
import type { Session } from '../types.ts';
import type { DecisionView } from '../util.ts';
import styles from './DecisionBody.module.css';
import { Composer } from './Composer.tsx';
import { Markdown } from './Markdown.tsx';
import { Options } from './Options.tsx';
import parts from './Parts.module.css';

export interface ComposerHooks {
  focus: number;
  note: string | null;
  onSend: (request: Request) => void;
  onEscape: () => void;
}

interface DecisionBodyProps {
  session: Session;
  decision: DecisionView;
  hidden: boolean;
  onDetails: () => void;
  onPick: (label: string) => void;
  // The reply box, while it shows.
  composer: ComposerHooks | null;
}

// An ask_human question: the question, Claude's details, the options and the reply box.
export function DecisionBody(p: DecisionBodyProps) {
  const { session, decision } = p;
  return (
    <div className={styles.body}>
      <h3 className={styles.problem}>{decision.problem}</h3>
      {decision.context && (
        <section className={styles.details} aria-label="Claude's details">
          <div className={styles.detailsHead}>
            <h4 className={parts.label}>Claude's details</h4>
            <button type="button" className={parts.tiny} aria-expanded={!p.hidden} onClick={p.onDetails}>
              {p.hidden ? 'Show' : 'Hide'} <kbd>Space</kbd>
            </button>
          </div>
          {!p.hidden && <div className={parts.body}><Markdown source={decision.context} /></div>}
        </section>
      )}
      <Options options={decision.options} onPick={p.onPick} />
      {p.composer && (
        <Composer
          session={session}
          decision={decision.key}
          label="Your own answer"
          placeholder={decision.options.length ? 'Or write your own answer, / for commands, paste or drop files…' : 'Reply, / for commands, paste or drop files…'}
          {...p.composer}
        />
      )}
    </div>
  );
}
