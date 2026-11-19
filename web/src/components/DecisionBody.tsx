import type { Request } from '../outbox.ts';
import type { Session } from '../types.ts';
import type { DecisionView } from '../util.ts';
import styles from './Card.module.css';
import { Composer } from './Composer.tsx';
import { Markdown } from './Markdown.tsx';
import { Options } from './Options.tsx';
import parts from './Parts.module.css';
import { Column, Headline } from './Parts.tsx';

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
  // The reply box while it is open.
  composer: ComposerHooks | null;
}

// An ask_human question: the question and Claude's details on the left, the options and the reply box on the right.
export function DecisionBody(p: DecisionBodyProps) {
  const { session, decision } = p;
  return (
    <div className={styles.cols}>
      <Column side="left">
        <Headline text={decision.problem} />
        {decision.context && (
          <section className={styles.details} aria-label="Claude's details">
            <div className={styles.detailsHead}>
              <h3 className={parts.label}>Claude's details</h3>
              <button type="button" className={parts.tiny} aria-expanded={!p.hidden} onClick={p.onDetails}>
                {p.hidden ? 'Show' : 'Hide'} <kbd>Space</kbd>
              </button>
            </div>
            {!p.hidden && <div className={parts.body}><Markdown source={decision.context} /></div>}
          </section>
        )}
      </Column>
      <Column side="right">
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
      </Column>
    </div>
  );
}
