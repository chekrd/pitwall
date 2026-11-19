import { decisionKey } from '../../server/decision.ts';
export { tildeIn } from '../../server/home.ts';
import type { QuestionOption, RepoView, Session } from './types.ts';

// `place` names the repository, or for a task across a folder of repos, the folder.
// Where a task works, as its tile and its page name it: the repositories, and the branch, or the branches of a folder task's
// worktrees. A worktree that is gone is named by its task folder, as git-wt lays it out in <task>/<repo folder>, not by
// the repository folder at the end of its path.
export function locate(repos: RepoView[], session: Session) {
  const repo = repos.find((r) => r.id === session.repoId);
  const worktree = repo?.worktrees.find((w) => w.path === session.worktree);
  const parts = session.worktree.split('/');
  const folder = (repo && parts.length > 2 && parts.at(-1) === repo.path.split('/').at(-1) ? parts.at(-2) : parts.at(-1)) || session.worktree;
  const task = folderTaskOf(repos, session);
  if (task) {
    const branches = [...new Set(task.worktrees.map((t) => t.worktree.branch).filter((b): b is string => !!b))];
    const names = [...new Set(task.worktrees.map((t) => t.repo.name))];
    return { repo, worktree, task, place: names.join(', ') || task.folder, branch: branches.join(', ') || folder };
  }
  return { repo, worktree, task, place: repo?.name, branch: worktree?.branch ?? folder };
}

// A task across a folder of repos runs in <folder>/worktrees/<task>, with a worktree <task>/<repo> in each repo it changes.
export function folderTaskOf(repos: RepoView[], session: Session) {
  if (session.repoId !== null) return null;
  const parent = session.worktree.slice(0, session.worktree.lastIndexOf('/worktrees/'));
  return {
    folder: parent.split('/').at(-1) ?? parent,
    worktrees: repos.flatMap((repo) => repo.worktrees
      .filter((w) => !w.isMain && w.path.slice(0, w.path.lastIndexOf('/')) === session.worktree)
      .map((worktree) => ({ repo, worktree }))),
  };
}

export const tilde = (path: string, home: string) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);
export const untilde = (path: string, home: string) => (home && (path === '~' || path.startsWith('~/')) ? `${home}${path.slice(1)}` : path);

// claude-opus-5-5 reads Opus 5.5 and the alias opus reads Opus, with or without the [1m] of a 1M context; a name of
// another shape shows as given.
export function modelName(model: string) {
  const m = /^(?:claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?|([a-z]+))(?:\[1m\])?$/.exec(model);
  if (!m) return model;
  const [, family = m[4], major, minor] = m;
  return `${family[0].toUpperCase()}${family.slice(1)}${major ? ` ${major}` : ''}${minor ? `.${minor}` : ''}`;
}

// Claude Code tells the size of the context window only to the status line; a request names the model without the
// [1m] of a 1M context, which the model picked keeps, and a conversation past 200k tokens can only be in a 1M one.
export function contextUse(session: Pick<Session, 'context' | 'model'>) {
  if (session.context === null) return null;
  const window = session.model?.endsWith('[1m]') || session.context > 200_000 ? 1_000_000 : 200_000;
  const k = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`);
  const percent = Math.round((session.context / window) * 100);
  return { percent, level: percent >= 80 ? 'high' : percent >= 50 ? 'mid' : 'low', tokens: `${k(session.context)} of ${k(window)} tokens` };
}

export const EFFORTS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

export const effortName = (effort: string) => EFFORTS[effort] ?? effort;

// A worktree is named by its folder under the worktree root, which git-wt makes <name>/<repo>.
export function worktreeName(path: string, repo: RepoView | undefined) {
  if (repo && (path === repo.path || !repo.worktrees.some((w) => w.path === path))) return 'None';
  const parts = path.split('/');
  if (repo && parts.length > 1 && parts.at(-1) === repo.name) parts.pop();
  return parts.at(-1) || path;
}

// A link as it reads in a list: its host without www and its path, without the scheme or a trailing slash.
export function shortUrl(url: string) {
  const u = URL.parse(url);
  return u ? `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}` : url;
}

const DELIVERED = [
  /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/,
  /^https?:\/\/[^/]+\/.+\/(?:pull|pullrequest|-\/merge_requests)\/\d+(?:[/?#]|$)/,
];

// A pull or merge request, or a claude.ai page, as opposed to a link Claude only cited.
export const isDelivered = (url: string) => DELIVERED.some((r) => r.test(url));

export const sessionLabel = (session: Session, branch: string) => session.title || branch;

export function ago(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export interface DecisionView {
  key: string;
  problem: string;
  context: string;
  options: QuestionOption[];
}

// The ask_human question the session waits on; a menu or a round is not one.
export function decisionOf(s: Session): DecisionView | null {
  const key = decisionKey(s);
  if (!key?.startsWith('q:')) return null;
  const q = s.question!;
  return { key, problem: q.title, context: q.details, options: q.options };
}

export type Attention = 'clearing' | 'decide' | 'focus' | 'working' | 'idle' | 'exited';
// As a task shows while a send to it waits out its hold: answered already, so it asks nothing.
export type Shown = Attention | 'sending';

export const shownOf = (s: Session, busy: ReadonlySet<string>): Shown => {
  const attention = attentionOf(s);
  return busy.has(s.id) && attention !== 'working' && attention !== 'exited' && attention !== 'clearing' ? 'sending' : attention;
};

export const MENU_GRACE_MS = 10_000;

// A menu the board answered stays open until Claude Code has taken the keys, with Claude reported as waiting.
const answeredMenuAt = (s: Session) => (s.menu && s.answered?.key === `m:${s.menu.toolUseId}` ? s.answered.at : null);

// The menu is still open 10 s after the board answered it, so the keys did not take and only the terminal can help.
export function menuStuck(s: Session, now = Date.now()) {
  const at = answeredMenuAt(s);
  return at !== null && s.status !== 'working' && s.status !== 'exited' && now >= at + MENU_GRACE_MS;
}

export function attentionOf(s: Session, now = Date.now()): Attention {
  if (s.clearing) return 'clearing';
  if (s.status === 'exited') return 'exited';
  if (decisionKey(s)) return 'decide';
  if (answeredMenuAt(s) !== null) return menuStuck(s, now) ? 'focus' : 'working';
  return s.status === 'waiting' ? 'focus' : s.status;
}

// When the session's attention changes with no new snapshot, or null if it cannot.
export function attentionChangesAt(s: Session) {
  const at = answeredMenuAt(s);
  return at === null ? null : at + MENU_GRACE_MS;
}

// Every time the board shows is on the 24-hour clock, whatever the locale's habit: 14:05, with the weekday when asked.
export const clock = (at: number, weekday = false) =>
  new Date(at).toLocaleString([], { ...(weekday && { weekday: 'short' as const }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const idOf = (v: unknown) => {
  const id = (v as { id?: unknown } | null)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
};

// `next` with every part that equals the one in `prev` kept as that very object, so a view memoized on it does not
// draw again. Items of a list that carry an id are matched by it, others by place.
export function share<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next) || typeof prev !== 'object' || typeof next !== 'object' || !prev || !next) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next;
    const byId = new Map(prev.flatMap((p) => (idOf(p) === undefined ? [] : [[idOf(p), p]])));
    let same = prev.length === next.length;
    const out = next.map((v, i) => {
      const id = idOf(v);
      const kept = share(id === undefined ? prev[i] : byId.get(id), v);
      if (kept !== prev[i]) same = false;
      return kept;
    });
    return (same ? prev : out) as T;
  }
  if (Array.isArray(prev)) return next;
  const before = prev as Record<string, unknown>;
  const keys = Object.keys(next);
  let same = keys.length === Object.keys(before).length;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = share(before[k], (next as Record<string, unknown>)[k]);
    if (out[k] !== before[k] || !(k in before)) same = false;
  }
  return (same ? prev : out) as T;
}
