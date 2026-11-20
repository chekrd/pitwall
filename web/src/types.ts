import type { ClearMark } from '../../server/clearing.ts';
import type { Session as Row } from '../../server/db.ts';
import type { Workflow } from '../../server/rpi.ts';

export type { Answered, Artifact, CodeRef, DocumentRef, Interrupted, Aside, Link, Parked, PrFlow, Question, QuestionOption, SessionStatus } from '../../server/db.ts';
// The mark and the workflow are optional for the mock's --legacy server, which predates them.
export type Session = Row & Partial<ClearMark> & { workflow?: Workflow | null };
export type { DocumentEntry, SupportingFile, TaskFolder, Workflow, WorkflowStep } from '../../server/rpi.ts';
export type { FullDiff, Upstream } from '../../server/git.ts';
export type { Conversation, ConversationLog, Exchange, Menu, MenuQuestion } from '../../server/conversations.ts';
export type { FolderView, RepoView, WorktreeView } from '../../server/workspace.ts';
export type { Command } from '../../server/commands.ts';
export type { MenuAnswer } from '../../server/menu.ts';
export type { Round, RoundAnswer, RoundAnswers, RoundQuestion } from '../../server/rounds.ts';
export type { Usage, UsageWindow } from '../../server/usage.ts';
export type { Drift } from '../../server/claudeFormat.ts';
export type { Run, Schedule, Scheduled, TaskRequest, When } from '../../server/schedule.ts';
export type { Snapshot } from '../../server/app.ts';
export type { TerminalNotice, WorktreeLoss } from '../../server/removal.ts';
export type { ActionBody, ActionName } from '../../server/contract.ts';
