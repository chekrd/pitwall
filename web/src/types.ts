import type { ClearMark } from '../../server/clearing.ts';
import type { Session as Row } from '../../server/db.ts';

export type { Advice, Answered, Artifact, Finding, Interrupted, Link, Findings, Parent, Parked, PrFlow, Priority, Resolution, Question, QuestionOption, SessionStatus, SubtaskKind, Summary } from '../../server/db.ts';
// The mark is optional for the mock's --legacy server, which predates it.
export type Session = Row & Partial<ClearMark>;
export type { FullDiff } from '../../server/git.ts';
export type { Conversation, ConversationLog, Exchange, Menu, MenuQuestion } from '../../server/conversations.ts';
export type { FolderView, RepoView, WorktreeView } from '../../server/workspace.ts';
export type { Command } from '../../server/commands.ts';
export type { MenuAnswer } from '../../server/menu.ts';
export type { Usage, UsageWindow } from '../../server/usage.ts';
export type { Drift } from '../../server/claudeFormat.ts';
export type { Run, Schedule, Scheduled, TaskRequest, When } from '../../server/schedule.ts';
