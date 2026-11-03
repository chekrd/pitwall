import styles from './Explain.module.css';

export interface Explanation {
  does: string;
  // What the Claude that gets it knows: the whole conversation, a copy of it, or nothing yet.
  sees?: string;
  session?: string;
}

// A tip on hover or keyboard focus, read out as the control's description, saying what an action does, what the Claude
// it reaches has in its context, and whether that is the task's own session or a separate one.
export function explain({ does, sees, session }: Explanation, align: 'start' | 'end' = 'end', className?: string) {
  const text = [does, sees && `What Claude has: ${sees}`, session && `Session: ${session}`].filter(Boolean).join('\n\n');
  return { className: [className, styles.explained].filter(Boolean).join(' '), 'data-explain': text, 'data-explain-align': align, 'aria-description': text };
}

const TASK = "the task's own session, the one doing the work";
const WHOLE = 'the whole conversation of the task, up to the moment the message arrives';
const COPY = 'a copy of the whole conversation as it stood when you first asked here, and the questions and answers of this aside since; nothing the task did after that';
const FORK = "a separate one, forked from the task's; it can read files and the web but not edit or run anything, and the task's Claude never sees it";

export const TIPS = {
  keep: { does: 'Keeps the text as a draft on this task. Nothing is sent.', sees: 'nothing of it until you send it', session: `${TASK}, once you send it` },
  auto: {
    does: "Sends this by itself when Claude ends its turn, with every other draft ticked so, as one message. Not when you replied first, the turn ended on a question, or the task is paused or archived; then it waits for the next end.",
    sees: WHOLE,
    session: TASK,
  },
  ask: {
    does: 'Asks the text as a question; no draft is kept. The answer shows here.',
    sees: 'a copy of the whole conversation as it stands right now; nothing the task does after',
    session: FORK,
  },
  sendNow: {
    does: 'Sends this draft as your next message, with 5 s to undo. While Claude works it reads it at its next step, which can change what it is doing.',
    sees: WHOLE,
    session: TASK,
  },
  sendAll: { does: 'Sends every draft as one message, with 5 s to undo.', sees: WHOLE, session: TASK },
  edit: { does: 'Changes the draft. Nothing is sent.' },
  delete: { does: 'Deletes the draft; the toast can undo it. Nothing is sent.' },
  followUp: { does: 'Asks another question in this same copy.', sees: COPY, session: `the same separate fork as this aside's first answer; the task's Claude never sees it` },
  keepAnswer: { does: 'Copies the last answer into a draft under Later, to edit and send when you decide.', sees: 'nothing of it until you send the draft', session: `${TASK}, once you send it` },
  stop: { does: 'Stops the copy answering this question. You can ask again.' },
  close: { does: "Forgets this aside and deletes the copy's transcript, so no follow-up can continue it.", session: "the fork ends; the task's own session is not touched" },
} satisfies Record<string, Explanation>;
