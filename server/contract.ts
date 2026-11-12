import { z } from 'zod';
import type { Snapshot, State } from './app.ts';
import type { Command } from './commands.ts';
import type { ConversationLog } from './conversations.ts';
import type { FullDiff, Upstream } from './git.ts';
import type { pauser } from './pause.ts';
import type { WorktreeLoss } from './removal.ts';
import type { Run, Schedule, TaskRequest } from './schedule.ts';
import type { modelChoices } from './tasks.ts';

// What server/app.ts, the mock and the page agree on: the bodies each route takes, checked with these schemas on the
// server and the mock, and what it answers. The page imports types alone, so no zod reaches its bundle.

export type { Snapshot, State };

const key = z.string().nullable().optional();
const none = z.strictObject({});
const files = z.array(z.string()).optional();

// What New task posts to start a task now; a schedule keeps the same with every field filled in.
const repoTask = z.strictObject({
  repoId: z.number().int(), name: z.string(), branch: z.string().optional(), path: z.string().optional(), prompt: z.string().optional(),
  files, existingBranch: z.boolean().optional(), model: z.string().optional(), effort: z.string().optional(),
});
const folderTask = z.strictObject({
  folder: z.string(), name: z.string(), prompt: z.string().optional(), files, model: z.string().optional(), effort: z.string().optional(),
});
const scheduledTask = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('repo'), repoId: z.number().int(), existingBranch: z.boolean(), branch: z.string(), path: z.string(), prompt: z.string(), files,
    model: z.string(), effort: z.string(),
  }),
  z.strictObject({ kind: z.literal('folder'), folder: z.string(), prompt: z.string(), files, model: z.string(), effort: z.string() }),
]) satisfies z.ZodType<TaskRequest>;

const when = z.union([z.strictObject({ at: z.number() }), z.strictObject({ time: z.string(), days: z.array(z.number()) })]);
const optionalPaused = z.strictObject({ paused: z.boolean().optional() });

export const actionBodies = {
  answer: z.strictObject({ key, choice: z.string().optional(), text: z.string().optional(), files: z.array(z.string()).optional(), drafts: z.array(z.string()).optional() }),
  dismiss: z.strictObject({ key }),
  rename: z.strictObject({ title: z.string() }),
  'decline-menu': z.strictObject({ toolUseId: z.string() }),
  'answer-menu': z.strictObject({ toolUseId: z.string(), answers: z.array(z.strictObject({ labels: z.array(z.string()), other: z.string() })) }),
  'answer-round': z.strictObject({
    round: z.string(), replies: z.record(z.string(), z.strictObject({ option: z.string().nullable(), recommended: z.boolean(), text: z.string() })),
  }),
  'accept-advice': z.strictObject({ key, adviceAt: z.number().optional() }),
  'retry-advice': z.strictObject({ key }),
  'stop-advice': z.strictObject({ key }),
  elaborate: z.strictObject({ key }),
  focus: none,
  finder: none,
  vscode: none,
  quit: none,
  forget: none,
  archive: z.strictObject({ archived: z.boolean().optional() }),
  priority: z.strictObject({ priority: z.enum(['high', 'low']).nullable() }),
  resolve: z.strictObject({ state: z.enum(['solved', 'dropped']).nullable() }),
  'delete-worktree': z.strictObject({ discard: z.boolean().optional() }),
  'dismiss-clear-error': none,
  finding: z.strictObject({ basis: z.string(), finding: z.number().int(), kind: z.string(), text: z.string().optional() }),
  park: z.strictObject({ text: z.string(), auto: z.boolean().optional() }),
  'edit-park': z.strictObject({ draft: z.string(), text: z.string().optional(), auto: z.boolean().optional() }),
  unpark: z.strictObject({ draft: z.string() }),
  'ask-aside': z.strictObject({ text: z.string(), aside: z.string().nullable().optional(), about: z.strictObject({ round: z.string(), question: z.string() }).optional() }),
  'stop-aside': z.strictObject({ aside: z.string() }),
  'close-aside': z.strictObject({ aside: z.string() }),
};

// POST /api/sessions/:id/<action>.
export type ActionName = keyof typeof actionBodies;
export const isAction = (name: string): name is ActionName => Object.hasOwn(actionBodies, name);

// These act on the decision the page showed and name it in `key`; answer, answer-menu, answer-round and decline-menu
// check their own.
export const onDecision: ReadonlySet<ActionName> = new Set(['dismiss', 'accept-advice', 'retry-advice', 'stop-advice', 'elaborate']);

// What the page sends, and what the server reads from it.
export type ActionBody<A extends ActionName> = z.input<(typeof actionBodies)[A]>;
export type ActionInput<A extends ActionName> = z.output<(typeof actionBodies)[A]>;

interface ActionAnswers {
  finding: { id: string | null };
  'ask-aside': { id: string };
}

// Every other action answers 204.
export type ActionResponse<A extends ActionName> = A extends keyof ActionAnswers ? ActionAnswers[A] : void;

export type ActionHandlers<S> = { [A in ActionName]: (subject: S, body: ActionInput<A>) => ActionResponse<A> | Promise<ActionResponse<A>> };

const repoSettings = z.strictObject({ baseBranch: z.string().nullable(), setupCommand: z.string().nullable(), worktreeRoot: z.string().nullable() }).partial();

// Every route that reads a body; the others take none.
export const bodies = {
  'POST /api/open': z.strictObject({ url: z.string() }),
  'POST /api/repos': z.strictObject({ path: z.string() }),
  'DELETE /api/roots': z.strictObject({ path: z.string() }),
  'PATCH /api/repos/:id': repoSettings,
  'POST /api/folder-tasks': folderTask,
  'POST /api/worktrees': repoTask,
  'DELETE /api/worktrees': z.strictObject({ repoId: z.number().int(), path: z.string(), force: z.boolean().optional(), deleteBranch: z.boolean().optional() }),
  'POST /api/schedules': z.strictObject({ name: z.string(), task: scheduledTask, when }),
  'PATCH /api/schedules/:id': z.strictObject({ paused: z.boolean() }),
  'POST /api/sessions': z.strictObject({ repoId: z.number().int(), worktree: z.string(), continueId: z.string().optional() }),
  'POST /api/shell': z.strictObject({ worktree: z.string() }),
  'POST /api/restart/resume': optionalPaused,
  'POST /api/restart/dismiss': optionalPaused,
  'POST /api/pause/resume': z.strictObject({ id: z.string().optional() }),
  'POST /api/ux': z.unknown(),
  // Claude Code's hook input, which grows fields of its own over time.
  'POST /api/hooks/ask-user-question': z.looseObject({ session_id: z.string().optional(), tool_use_id: z.string().optional(), tool_input: z.unknown() }),
  'POST /api/hooks/event': z.looseObject({}),
} satisfies { [K in Route]?: z.ZodType };

type Pausing = ReturnType<typeof pauser>;
type Started = { path: string; sessionId: string };
export type Branch = { name: string; local: boolean; origin: boolean; worktree: string | null };
export type Models = Awaited<ReturnType<typeof modelChoices>>;
export type Resumed = { resumed: number; failed: { id: string; error: string }[] };

// What each JSON route answers; void is a 204. Pictures, artifacts, uploads and the sessions' actions are not here.
export interface Responses {
  'GET /api/state': State;
  'POST /api/pick-folder': { path: string };
  'POST /api/open': void;
  'POST /api/repos': { scanned: boolean };
  'DELETE /api/roots': void;
  'POST /api/rescan': void;
  'PATCH /api/repos/:id': void;
  'DELETE /api/repos/:id': void;
  'GET /api/repos/:id/branches': Branch[];
  'GET /api/repos/:id/models': Models;
  'GET /api/folders/models': Models;
  'POST /api/folder-tasks': Started;
  'POST /api/worktrees': Started;
  'DELETE /api/worktrees': void;
  'POST /api/schedules': Schedule;
  'PATCH /api/schedules/:id': void;
  'DELETE /api/schedules/:id': void;
  'POST /api/schedules/:id/run': Run;
  'POST /api/sessions': { id: string };
  'POST /api/shell': void;
  'GET /api/sessions/:id/conversation': ConversationLog[];
  'GET /api/sessions/:id/delete-worktree': WorktreeLoss;
  'POST /api/restart/resume': Resumed;
  'POST /api/restart/dismiss': void;
  'POST /api/pause': ReturnType<Pausing['start']>;
  'POST /api/pause/now': Awaited<ReturnType<Pausing['hurry']>>;
  'POST /api/pause/resume': Resumed;
  'POST /api/pause/dismiss': void;
  'POST /api/ux': void;
  'POST /api/hooks/ask-user-question': void;
  'POST /api/hooks/event': void;
  'GET /api/commands': Command[];
  'GET /api/diff/file': FullDiff;
  'GET /api/upstream': Upstream | null;
  'GET /api/diff': FullDiff;
}

export type Route = keyof Responses;
export type Method = Route extends `${infer M} ${string}` ? M : never;

// What the page sends to a route, and what the server reads from it.
export type RouteBody<K extends Route> = K extends keyof typeof bodies ? z.input<(typeof bodies)[K]> : undefined;
export type RouteInput<K extends keyof typeof bodies> = z.output<(typeof bodies)[K]>;

// The paths a route's pattern stands for, each :param any segment, with or without a query.
type Pattern<P extends string> = P extends `${infer A}:${string}/${infer B}` ? `${A}${string}/${Pattern<B>}`
  : P extends `${infer A}:${string}` ? `${A}${string}` : P;
type PathsOf<K> = K extends `${string} ${infer P}` ? Pattern<P> | `${Pattern<P>}?${string}` : never;

export type Paths<M extends Method> = { [K in Route]: K extends `${M} ${string}` ? PathsOf<K> : never }[Route];
export type RouteAt<M extends Method, P extends string> = { [K in Route]: K extends `${M} ${string}` ? (P extends PathsOf<K> ? K : never) : never }[Route];

// A body that may be left out, as one with every field optional or a route that reads none.
export type BodyArgs<B, O> = [B] extends [undefined] ? [body?: undefined, options?: O] : {} extends B ? [body?: B, options?: O] : [body: B, options?: O];
