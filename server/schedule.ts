import { RPI_NEEDS_WORKTREE } from './rpi.ts';

// What New task posts, kept to start the same task later.
export type TaskRequest =
  | { kind: 'repo'; repoId: number; existingBranch: boolean; branch: string; path: string; prompt: string; files?: string[] | undefined; model: string; effort: string; workflow?: Workflow | undefined }
  | { kind: 'folder'; folder: string; prompt: string; files?: string[] | undefined; model: string; effort: string; workflow?: Workflow | undefined };

// A workflow the task's first prompt starts: rpi, the skill of HumanLayer's plugin.
export type Workflow = 'rpi';

// Claude starts on the prompt with the attached files' paths under it, and reads them from there.
export const taskPrompt = (prompt: string, files: readonly string[]) => [prompt.trim(), files.join('\n')].filter(Boolean).join('\n\n');

// Once at `at`, or at `time` (HH:MM, local) on each of `days` (0 is Sunday).
export type When = { at: number } | { time: string; days: number[] };

export interface Run {
  // null for a run started by hand.
  due: number | null;
  at: number;
  sessionId: string | null;
  error: string | null;
}

export interface Schedule {
  id: string;
  name: string;
  task: TaskRequest;
  when: When;
  // null once a one-off has run.
  next: number | null;
  paused: boolean;
  last: Run | null;
  createdAt: number;
}

// The schedule a task was started by, and when; `due` is null for Run now.
export interface Scheduled {
  id: string;
  name: string;
  due: number | null;
  at: number;
}

// A run that starts this much after it was due, the Mac asleep or Pitwall down meanwhile, says it started late.
export const LATE_MS = 2 * 60_000;

const MINUTE = 60_000;

// Schedules run on whole minutes, so one look at the start of each minute starts every run on time.
export const untilNextMinute = (now: number) => MINUTE - (now % MINUTE);

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NAME = /^[A-Za-z0-9._-]+$/;

export const repeats = (when: When): when is { time: string; days: number[] } => 'time' in when;

export function nextRun(when: When, after: number): number | null {
  if (!repeats(when)) return when.at > after ? when.at : null;
  const [, h, m] = TIME.exec(when.time)!;
  const day = new Date(after);
  for (let i = 0; i <= 7; i++) {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() + i, Number(h), Number(m)).getTime();
    if (at > after && when.days.includes(new Date(at).getDay())) return at;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const stampOf = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};

// A schedule left unnamed is named by the first words of its prompt.
export function nameFromPrompt(prompt: string) {
  const words = prompt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 5);
  let name = '';
  for (const w of words) {
    const next = name ? `${name}-${w}` : w;
    if (next.length > 40) break;
    name = next;
  }
  return name || words[0]?.slice(0, 40) || 'task';
}

// A repeating schedule's runs each get a task name, worktree and branch of their own, stamped with the run's date and time.
export function runOf(s: Pick<Schedule, 'name' | 'when' | 'task'>, at: number, taken: ReadonlySet<string>): { name: string; task: TaskRequest } {
  if (!repeats(s.when)) {
    let name = s.name;
    for (let i = 2; taken.has(name); i++) name = `${s.name}-${i}`;
    return { name, task: s.task };
  }
  const stamp = `-${stampOf(at)}`;
  const branch = s.task.kind === 'repo' && !s.task.existingBranch ? s.task.branch.trim() : '';
  let suffix = stamp;
  for (let i = 2; taken.has(s.name + suffix) || (branch && taken.has(branch + suffix)); i++) suffix = `${stamp}-${i}`;
  return { name: s.name + suffix, task: branch ? { ...s.task, branch: branch + suffix } as TaskRequest : s.task };
}

export function parseSchedule(body: { name?: string; task?: unknown; when?: unknown }, now: number): Pick<Schedule, 'name' | 'task' | 'when'> {
  const task = body.task as TaskRequest;
  if (task?.kind !== 'repo' && task?.kind !== 'folder') throw new Error('unknown task');
  if (!(task.prompt ?? '').trim()) throw new Error('a scheduled task needs a prompt');
  if (task.kind === 'repo' && task.existingBranch && task.workflow === 'rpi') throw new Error(RPI_NEEDS_WORKTREE);
  const name = (body.name ?? '').trim() || (task.kind === 'repo' && task.existingBranch ? task.branch.trim().replaceAll('/', '-') : nameFromPrompt(task.prompt));
  if (!NAME.test(name)) throw new Error('name the task: letters, digits, dot, hyphen and underscore');
  const w = body.when as Partial<{ at: number; time: string; days: number[] }>;
  let when: When;
  if (typeof w?.at === 'number') {
    if (w.at % MINUTE) throw new Error('a task starts on a whole minute');
    if (w.at <= now) throw new Error('that time has passed');
    when = { at: w.at };
  } else if (typeof w?.time === 'string' && TIME.test(w.time) && Array.isArray(w.days)) {
    const days = [...new Set(w.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).toSorted((a, b) => a - b);
    if (!days.length) throw new Error('pick at least one day');
    when = { time: w.time, days };
  } else throw new Error('say when the task starts');
  if (repeats(when) && task.kind === 'repo' && !task.existingBranch && task.path.trim()) {
    throw new Error('each run of a repeating task gets a worktree of its own; leave Worktree path empty');
  }
  return { name, task, when };
}

export interface SchedulerDeps {
  list: () => Schedule[];
  save: (s: Schedule) => void;
  // Starts the run's task under its name and returns its session id.
  start: (task: TaskRequest, name: string, scheduled: Scheduled) => Promise<string>;
  taken: () => ReadonlySet<string>;
  now?: () => number;
}

// A step starts every schedule that is due, once however many runs it missed, and moves it to its next run after now.
export function scheduler({ list, save, start, taken, now = Date.now }: SchedulerDeps) {
  const running = new Set<string>();

  async function fire(s: Schedule, due: number | null) {
    running.add(s.id);
    const at = now();
    const { name, task } = runOf(s, due ?? at, taken());
    let run: Run;
    try {
      run = { due, at, sessionId: await start(task, name, { id: s.id, name: s.name, due, at }), error: null };
    } catch (err) {
      run = { due, at, sessionId: null, error: err instanceof Error ? err.message : String(err) };
    } finally {
      running.delete(s.id);
    }
    const current = list().find((x) => x.id === s.id);
    if (!current) return run;
    save({ ...current, last: run, ...(due !== null && { next: repeats(current.when) ? nextRun(current.when, Math.max(due, now())) : null }) });
    return run;
  }

  return {
    step: async () => {
      const t = now();
      const due = list().filter((s) => !s.paused && s.next !== null && s.next <= t && !running.has(s.id));
      await Promise.all(due.map((s) => fire(s, s.next)));
    },
    runNow: async (id: string) => {
      const s = list().find((x) => x.id === id);
      if (!s) throw new Error('unknown schedule');
      if (running.has(id)) throw new Error('this schedule is starting its task already');
      return fire(s, null);
    },
  };
}
