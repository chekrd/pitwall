import type { Menu, Question, QuestionOption, Session } from './types.ts';

// Sessions for the web tests, in the snapshot's shape.

export const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id, conversation: id, history: [], repoId: 1, worktree: `/w/${id}`, cwd: `/w/${id}`, pid: 1, tty: '/dev/ttys001', title: id, firstPrompt: null, status: 'idle',
  question: null, diffstat: null, lastMessage: null, lastPrompt: null, unanswered: null, lastTurn: 't1', waitingFor: null,
  dismissedAsk: null, round: null, dismissedRound: null, prs: [], activity: null, menu: null, answered: null, artifacts: [], links: [], model: null, effort: null, context: null, interrupted: null, turnError: null, scheduled: null, starting: null, parked: [], asides: [], aliveAt: null, archived: false,
  createdAt: 0, updatedAt: 0, ...patch,
});

export const options = (...labels: string[]): QuestionOption[] => labels.map((label) => ({ label }));

export const question = (toolUseId: string, choices = options('Keep', 'Merge'), askedAt = 1): Question =>
  ({ toolUseId, title: 'Which cart wins?', details: 'd', options: choices, category: 'product decision', askedAt });

export const menu = (toolUseId: string, ...questions: Menu['questions']): Menu => ({
  toolUseId, at: 1,
  questions: questions.length ? questions : [
    { question: 'Backoff?', header: 'Backoff', multiSelect: false, options: options('Exponential', 'Linear') },
    { question: 'Then?', header: 'Give up', multiSelect: true, options: options('Email', 'Disable', 'Log') },
  ],
});
