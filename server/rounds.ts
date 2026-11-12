// Also imported by the UI, so no imports that run here.

export interface RoundOption {
  label: string;
  description?: string | undefined;
}

export interface RoundQuestion {
  // Q1, Q2, … in the order asked; the answers name each question by it.
  id: string;
  title: string;
  body: string;
  options: RoundOption[];
  // Claude's recommended answer in its own words, '' when it gave none.
  recommendation: string;
  // The option that recommendation picks, when it is one of them.
  recommended: string | null;
}

// Several questions Claude asked at once, each answered on its own and all sent back as one message.
export interface Round {
  // The ask_questions call, or the message of a round written as text.
  key: string;
  source: 'tool' | 'prose';
  title: string;
  intro: string;
  questions: RoundQuestion[];
  at: number;
}

// `recommended` takes Claude's recommendation as it stands, for one that is no option.
export interface RoundAnswer {
  option: string | null;
  recommended: boolean;
  text: string;
}

export type RoundAnswers = Record<string, RoundAnswer>;

export const NO_ANSWER: RoundAnswer = { option: null, recommended: false, text: '' };

export const isAnswered = (a: RoundAnswer | undefined): a is RoundAnswer => !!a && (a.option !== null || a.recommended || !!a.text.trim());

export const answeredCount = (round: Round, answers: RoundAnswers) => round.questions.filter((q) => isAnswered(answers[q.id])).length;

// Claude's recommendation as an answer: its option, or the recommendation itself when it is none of them.
export function recommendedAnswer(q: RoundQuestion, text = ''): RoundAnswer | null {
  if (q.recommended) return { option: q.recommended, recommended: false, text };
  return q.recommendation ? { option: null, recommended: true, text } : null;
}

export const roundTitle = (round: Round) =>
  round.title || (round.questions.length === 1 ? round.questions[0].title : `${round.questions.length} questions: ${round.questions.map((q) => q.title).join(' · ')}`);

export function roundAnswerLabel(round: Round, answers: RoundAnswers) {
  const n = answeredCount(round, answers);
  const all = round.questions.length;
  return n === all ? (all === 1 ? 'Answer to the question' : `Answers to all ${all} questions`) : `Answers to ${n} of ${all} questions`;
}

const TAKEN = 'Your recommendation';
const OPEN = 'not answered yet; keep it open';

// The message Claude gets. A question left out stays open, said in so many words, so Claude asks it again.
export function roundReply(round: Round, answers: RoundAnswers) {
  for (const id of Object.keys(answers)) if (!round.questions.some((q) => q.id === id)) throw new Error(`no question ${id} in this round`);
  if (!answeredCount(round, answers)) throw new Error('answer at least one question first');
  const lines = round.questions.map((q) => {
    const a = answers[q.id];
    if (!isAnswered(a)) return `${q.id} — ${q.title}: ${OPEN}`;
    if (a.option !== null && !q.options.some((o) => o.label === a.option)) throw new Error(`unknown option for ${q.id}`);
    if (a.recommended && !q.recommendation) throw new Error(`${q.id} has no recommendation to take`);
    const said = [a.option ?? (a.recommended ? TAKEN : ''), a.text.trim()].filter(Boolean).join(' — ');
    return `${q.id} — ${q.title}: ${said}`;
  });
  return `My answers to your questions:\n\n${lines.join('\n\n')}`;
}

// The round as plain text, for the models that rank and summarize it.
export const roundText = (round: Round) =>
  round.questions.map((q) =>
    `${q.id} — ${q.title}: ${q.body}` +
    q.options.map((o) => `\n   - ${o.label}${o.description ? `: ${o.description}` : ''}`).join('') +
    (q.recommendation ? `\n   Claude recommends: ${q.recommendation}` : '')).join('\n');

const QUESTION = /^❓\s*\*\*(Q\d+)\*\*\s*[-–—:]\s*\*\*(.+?)\*\*\s*:?[ \t]*(.*)$/;
const RECOMMENDS = /^➡️?\s*(.*)$/;
const RULE = /^\s*-{3,}\s*$/;
const LETTERED = /^\s*[-*]\s+(\(([a-z])\)\s+\S.*)$/;

interface Draft {
  id: string;
  title: string;
  body: string[];
  recommendation: string[] | null;
}

function finish(d: Draft): RoundQuestion {
  const lettered = d.body.filter((l) => LETTERED.test(l));
  // One lettered line is a remark, not a choice.
  const options = lettered.length > 1 ? lettered.map((l) => ({ label: l.match(LETTERED)![1].trim() })) : [];
  const body = (options.length ? d.body.filter((l) => !LETTERED.test(l)) : d.body).join('\n').trim();
  const recommendation = (d.recommendation ?? []).join('\n').trim();
  const letter = recommendation.match(/^\(([a-z])\)/)?.[1];
  const recommended = letter ? options.find((o) => o.label.startsWith(`(${letter})`))?.label ?? null : null;
  return { id: d.id, title: d.title.trim(), body, options, recommendation, recommended };
}

// A round written as text in the grill-me format: `❓ **Q1** - **title**: question`, then `➡️ recommendation`, a rule
// between questions. Lettered list items, `- (a) …`, are the question's options. Null for text that holds none.
export function proseRound(text: string): Pick<Round, 'intro' | 'questions'> | null {
  if (!text.includes('❓')) return null;
  const intro: string[] = [];
  const drafts: Draft[] = [];
  let open: Draft | null = null;
  for (const line of text.split('\n')) {
    const asked = line.match(QUESTION);
    if (asked) {
      open = { id: asked[1], title: asked[2], body: [asked[3]], recommendation: null };
      drafts.push(open);
    } else if (!open) {
      if (!drafts.length) intro.push(line);
    } else if (RULE.test(line)) {
      open = null;
    } else if (!open.recommendation && RECOMMENDS.test(line)) {
      open.recommendation = [line.match(RECOMMENDS)![1]];
    } else {
      (open.recommendation ?? open.body).push(line);
    }
  }
  const questions = drafts.map(finish);
  if (!questions.length || new Set(questions.map((q) => q.id)).size !== questions.length) return null;
  return { intro: intro.join('\n').trim(), questions };
}
