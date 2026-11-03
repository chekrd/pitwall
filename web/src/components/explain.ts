import { PAUSE_PROMPT, RESUME_PROMPT } from '../../../server/pause.ts';

export interface Explanation {
  does: string;
  // What the Claude that gets it knows: the whole conversation, a copy of it, or nothing yet.
  sees?: string;
  session?: string;
}

// The tooltip of an action that reaches Claude, read out as the control's description: what it does, what the Claude it
// reaches has in its context, and whether that is the task's own session or a separate one.
export function explain({ does, sees, session }: Explanation) {
  const text = [does, sees && `What Claude has: ${sees}`, session && `Session: ${session}`].filter(Boolean).join('\n\n');
  return { 'data-explain': text, 'aria-description': text };
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

const SUBTASK_SEES = "the task's first prompt, this finding and your note; nothing of the review's conversation";
const SUBTASK = 'a new session of its own, a subtask in this same worktree, where other subtasks may work at the same time';
const ONE_OFF_SEES = "the task's first prompt, this decision with its options and Claude's last message, and the code it reads; not the conversation";

// Actions elsewhere on the board that send text to a Claude, where the button does not say which one or what it knows.
export const SENDS = {
  findingAccept: { does: 'Starts a new Claude that checks this finding against the code and fixes it if it holds; your note goes along.', sees: SUBTASK_SEES, session: SUBTASK },
  findingElaborate: { does: 'Starts a new Claude that explains this finding without changing files; your note goes along.', sees: SUBTASK_SEES, session: SUBTASK },
  findingSecondLook: { does: 'Starts a new Claude that checks on its own whether this finding is real, without changing files.', sees: SUBTASK_SEES, session: SUBTASK },
  findingReply: { does: 'Starts a new Claude that acts on your answer.', sees: "the task's first prompt, this finding and your answer; nothing of the review's conversation", session: SUBTASK },
  elaborate: {
    does: 'A model (Sonnet) reads the code and explains the background and what each choice would mean, changing nothing. It runs once per decision.',
    sees: ONE_OFF_SEES,
    session: "a one-off run of its own; the task's Claude never sees it",
  },
  adviceRetry: {
    does: 'Asks for the second opinion again: a model (Opus) reads the code, may try things in a scratch copy of the worktree, and suggests an answer.',
    sees: ONE_OFF_SEES,
    session: "a one-off run of its own; nothing reaches the task's Claude unless you accept its suggestion",
  },
  acceptAdvice: { does: "Sends the second opinion's pick and answer as your reply, with 5 s to undo.", sees: WHOLE, session: TASK },
  prompt: (text: string, how = 'with 5 s to undo'): Explanation => ({ does: `Sends Claude, ${how}: “${text}”`, sees: WHOLE, session: TASK }),
  resume: {
    does: `Sends Claude: “${RESUME_PROMPT}” If its Claude ended meanwhile, it comes back first with claude --resume.`,
    sees: WHOLE,
    session: `${TASK}, resumed in its own conversation`,
  },
  pause: {
    does: `Pause before you close the laptop or restart the Mac. Every Claude at work finishes its turn (or now, with Stop now), then gets: “${PAUSE_PROMPT}” Resume carries on.`,
    sees: 'each its own whole conversation',
    session: "each task's own session",
  },
  resumePaused: {
    does: `Every paused task gets: “${RESUME_PROMPT}” One whose Claude ended comes back first with claude --resume.`,
    sees: 'each its own whole conversation',
    session: "each task's own session, resumed in its own conversation",
  },
  resumeRestart: {
    does: `Brings back every task the restart ended with claude --resume, in a hidden terminal, as it was; nothing is sent to them. A paused one also gets: “${RESUME_PROMPT}”`,
    sees: 'each its own whole conversation',
    session: "each task's own session, resumed in its own conversation",
  },
  bugReport: {
    does: 'Starts a new Pitwall task that reproduces the bug, fixes it and delivers the fix, or stops and says so when the evidence does not explain it.',
    sees: "what you wrote, the board's recorded events of the last minutes and the page as it was; nothing of your tasks' conversations",
    session: 'a new session of its own, in the Pitwall repository',
  },
} satisfies Record<string, Explanation | ((text: string, how?: string) => Explanation)>;
