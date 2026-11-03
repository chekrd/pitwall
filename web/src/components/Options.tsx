import type { Frozen } from '../deck.ts';
import type { Advice, QuestionOption } from '../types.ts';
import type { Covered } from '../util.ts';
import styles from './Options.module.css';
import parts from './Parts.module.css';
import { level } from './SecondOpinion.tsx';

// The second opinion's reply, its reasoning and how sure it is, with Edit to take it into the reply box.
function Suggestion({ advice, onEdit }: { advice: Advice; onEdit: () => void }) {
  return (
    <>
      <p className={styles.answer}>{advice.answer}</p>
      {advice.reasoning && <p className={styles.reasoning}>{advice.reasoning}</p>}
      <div className={styles.actions}>
        <button type="button" className={parts.tiny} title="Copy the suggestion into the reply box to change it first" onClick={onEdit}>
          Edit <kbd>E</kbd>
        </button>
        <span className={styles.level} title="How sure the second opinion is that you would decide the same">{level(advice.confidence)} confidence you agree</span>
      </div>
    </>
  );
}

interface OptionsProps {
  options: readonly QuestionOption[];
  // A finished second opinion for this decision, whenever it finished.
  advice: Advice | null;
  frozen: Frozen | null;
  composing: boolean;
  // The standalone suggestion is what ⏎ already accepts, so it needs no button of its own.
  accepting: boolean;
  onPick: (label: string) => void;
  onAccept: () => void;
  onEdit: () => void;
  // Which findings each option acts on, for an end-of-turn decision about the task's findings.
  coverage?: ((o: QuestionOption) => Covered[]) | null;
}

const PICK_TITLE = 'A second model checked the code on its own and would pick this; the percentage is how likely it thinks you pick it too';

function Coverage({ covered }: { covered: Covered[] }) {
  const handled = covered.filter((c) => c.handled).map((c) => c.n);
  const list = (ns: number[]) => (ns.length > 1 ? `${ns.slice(0, -1).join(', ')} and ${ns.at(-1)}` : String(ns[0]));
  return (
    <span className={styles.covers} data-covers title="Claude does this itself, in this session; the buttons on a finding start a separate agent for just that one">
      Acts on finding{covered.length === 1 ? '' : 's'} {list(covered.map((c) => c.n))}
      {handled.length > 0 && <span className={styles.handled}> · {list(handled)} already answered on {handled.length === 1 ? 'its' : 'their'} own</span>}
    </span>
  );
}

// Claude's options, in its order: each sends itself when pressed. The frozen choice, what ⏎ sends, is highlighted; the
// second opinion shows on the one option it picked, or as a block of its own when it picked none of them.
export function Options({ options, advice, frozen, composing, accepting, onPick, onAccept, onEdit, coverage }: OptionsProps) {
  const chosen = frozen && frozen.via !== 'menu' ? frozen.label : null;
  const apart = advice && !options.some((o) => o.label === advice.choice);
  return (
    <>
      {apart && (
        <div className={styles.standalone} data-frozen={(frozen?.via === 'advice' && frozen.label === null && frozen.adviceAt === advice.at) || undefined} data-suggestion>
          <div className={styles.standaloneHead}>
            <span className={parts.tag} title="A second model checked the code on its own and answers with none of Claude's options; the percentage is how likely it thinks you answer the same">Second opinion's own answer · {advice.confidence}%</span>
            {!accepting && <button type="button" className={styles.accept} onClick={onAccept}>Accept suggestion</button>}
          </div>
          {!composing && <Suggestion advice={advice} onEdit={onEdit} />}
        </div>
      )}
      {options.length > 0 && (
        <div className={styles.options} role="group" aria-label="Claude's options">
          <div className={styles.head}>
            <h3 className={parts.label}>Claude's options</h3>
            <span className={styles.order}>in the order Claude gave them, not ranked</span>
          </div>
          {options.map((o, i) => {
            const suggested = advice?.choice === o.label;
            const covered = coverage?.(o) ?? [];
            return (
              <div key={o.label} className={styles.option} data-frozen={o.label === chosen || undefined}>
                <button type="button" className={styles.button} data-option={i + 1} onClick={() => onPick(o.label)}>
                  <span className={styles.badge}>{i + 1}</span>
                  <span className={styles.text}>
                    <span className={styles.label}>{o.label}</span>
                    {o.description && <span className={styles.description}>{o.description}</span>}
                    {covered.length > 0 && <Coverage covered={covered} />}
                  </span>
                  <span className={styles.tags}>
                    {suggested && <span className={parts.tag} title={PICK_TITLE}>Second opinion's pick · {advice!.confidence}%</span>}
                    {o.recommended && <span className={parts.tag} data-quiet title="Claude marked this option as the one it would choose">Claude recommends</span>}
                  </span>
                </button>
                {suggested && !composing && (
                  <div className={styles.suggestion} data-suggestion>
                    <Suggestion advice={advice!} onEdit={onEdit} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
