import { useState, type KeyboardEvent } from 'react';
import { answeredCount, isAnswered, NO_ANSWER, recommendedAnswer } from '../../../server/rounds.ts';
import type { Aside, Round, RoundAnswer, RoundAnswers, RoundQuestion, Session } from '../types.ts';
import { AsideCard, discuss } from './Asides.tsx';
import { explain, TIPS } from './explain.ts';
import { Markdown } from './Markdown.tsx';
import parts from './Parts.module.css';
import styles from './RoundBody.module.css';

// Enter is done with the field and Shift+Enter breaks the line, as in the board's other fields; Esc leaves it too.
const leaves = (e: KeyboardEvent<HTMLTextAreaElement>) => (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === 'Escape';

// Talking one question through with a copy of the conversation: the first ask opens it, with nothing written too.
function Discuss({ session, round, question, aside, onUse }: { session: Session; round: Round; question: RoundQuestion; aside: Aside | undefined; onUse: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  if (aside) {
    return (
      <AsideCard session={session} aside={aside} as="div">
        <button type="button" {...explain(TIPS.useAnswer)} onClick={() => onUse(aside.turns.at(-1)!.answer!)}>Use as my answer</button>
      </AsideCard>
    );
  }
  const ask = () => {
    const said = text.trim();
    setText('');
    setOpen(false);
    void discuss(session, { round: round.key, question: question.id }, said).then((ok) => {
      if (ok) return;
      setText(said);
      setOpen(true);
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    ask();
  };
  if (!open) {
    return (
      <button type="button" className={parts.tiny} data-discuss {...explain(TIPS.discuss)} disabled={session.archived || session.lastTurn === null} onClick={() => setOpen(true)}>
        Discuss
      </button>
    );
  }
  return (
    <div className={styles.ask}>
      <textarea
        autoFocus
        className={styles.field}
        aria-label={`What to discuss about ${question.id}`}
        placeholder="What do you want to know? Leave it empty to have the question talked through…"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" {...explain(TIPS.discuss)} onClick={ask}>Ask <kbd>↵</kbd></button>
    </div>
  );
}

interface QuestionProps {
  session: Session;
  round: Round;
  question: RoundQuestion;
  answer: RoundAnswer;
  onAnswer: (answer: RoundAnswer) => void;
}

function Question({ session, round, question: q, answer, onAnswer }: QuestionProps) {
  const aside = session.asides.find((a) => a.about?.round === round.key && a.about.question === q.id);
  const answered = isAnswered(answer);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!leaves(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.blur();
  };
  return (
    <section className={styles.question} data-question={q.id} data-answered={answered || undefined} aria-label={`${q.id}: ${q.title}`}>
      <header className={styles.head}>
        <span className={styles.n}>{q.id}</span>
        <h2>{q.title}</h2>
        {answered && <span className={parts.tag} data-quiet>Answered</span>}
      </header>
      {q.body && <div className={styles.body}><Markdown source={q.body} /></div>}
      {q.options.length > 0 && (
        <div className={styles.options} role="group" aria-label={`Options for ${q.id}`}>
          {q.options.map((o) => (
            <button
              key={o.label}
              type="button"
              className={styles.option}
              data-round-option
              aria-pressed={answer.option === o.label}
              onClick={() => onAnswer({ ...answer, option: answer.option === o.label ? null : o.label, recommended: false })}
            >
              <span className={styles.text}>
                <span className={styles.label}>{o.label}</span>
                {o.description && <span className={styles.description}>{o.description}</span>}
              </span>
              {q.recommended === o.label && <span className={parts.tag} data-explain="The answer Claude recommends">Recommended</span>}
            </button>
          ))}
        </div>
      )}
      {q.recommendation && (
        <div className={styles.recommends} data-recommends data-taken={answer.recommended || undefined}>
          <div className={styles.recommendsHead}>
            <span className={parts.label}>Claude recommends</span>
            {!q.recommended && (
              <button
                type="button"
                className={parts.tiny}
                aria-pressed={answer.recommended}
                data-explain="Answer with Claude's recommendation as it stands; what you write below goes along as a note"
                onClick={() => onAnswer({ ...answer, option: null, recommended: !answer.recommended })}
              >
                {answer.recommended ? 'Taken' : 'Take it'}
              </button>
            )}
          </div>
          <Markdown source={q.recommendation} />
        </div>
      )}
      <textarea
        className={styles.own}
        aria-label={`Your answer to ${q.id}`}
        placeholder={q.options.length || q.recommendation ? 'Your own answer, or a note to go with your pick…' : 'Your answer…'}
        value={answer.text}
        onChange={(e) => onAnswer({ ...answer, text: e.currentTarget.value })}
        onKeyDown={onKeyDown}
      />
      <Discuss session={session} round={round} question={q} aside={aside} onUse={(text) => onAnswer({ ...answer, text })} />
    </section>
  );
}

interface RoundBodyProps {
  session: Session;
  round: Round;
  answers: RoundAnswers;
  onAnswers: (answers: RoundAnswers) => void;
}

// A round of questions: each answered on its own, by an option, Claude's recommendation or an own answer, and talked
// through first if need be. The answers are sent together by whoever shows the round.
export function RoundBody({ session, round, answers, onAnswers }: RoundBodyProps) {
  const all = round.questions.length;
  const done = answeredCount(round, answers);
  const rest = round.questions.filter((q) => !isAnswered(answers[q.id]) && recommendedAnswer(q));
  const takeRest = () => onAnswers({ ...answers, ...Object.fromEntries(rest.map((q) => [q.id, recommendedAnswer(q)!])) });
  return (
    <div className={styles.round} data-round={round.key}>
      {round.intro && <div className={styles.intro}><Markdown source={round.intro} /></div>}
      <div className={styles.progress}>
        <strong data-round-progress>{done} of {all} answered</strong>
        {done < all && <span>What you leave out stays open; Claude asks it again.</span>}
        <span className={styles.spacer} />
        {rest.length > 0 && (
          <button type="button" className={parts.tiny} {...explain(TIPS.takeRest)} onClick={takeRest}>
            {done ? 'Take the other recommendations' : 'Take every recommendation'}
          </button>
        )}
      </div>
      {round.questions.map((q) => (
        <Question key={q.id} session={session} round={round} question={q} answer={answers[q.id] ?? NO_ANSWER} onAnswer={(a) => onAnswers({ ...answers, [q.id]: a })} />
      ))}
    </div>
  );
}
