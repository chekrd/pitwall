import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextRun, parseSchedule, runName, scheduler, type Schedule } from './schedule.ts';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
// Monday 2 November 2026.
const MON = (h = 0, mi = 0) => local(2026, 11, 2, h, mi);
const WEEKDAYS = [1, 2, 3, 4, 5];

test('a repeating schedule runs next at its time on the next of its days after now', () => {
  assert.equal(nextRun({ time: '09:00', days: WEEKDAYS }, MON(8)), MON(9));
  assert.equal(nextRun({ time: '09:00', days: WEEKDAYS }, MON(9)), local(2026, 11, 3, 9));
  assert.equal(nextRun({ time: '09:00', days: WEEKDAYS }, local(2026, 11, 6, 10)), local(2026, 11, 9, 9));
  assert.equal(nextRun({ time: '22:30', days: [1] }, MON(23)), local(2026, 11, 9, 22, 30));
});

test('a one-off runs at its time, and not again once it has passed', () => {
  assert.equal(nextRun({ at: MON(22) }, MON(8)), MON(22));
  assert.equal(nextRun({ at: MON(22) }, MON(22)), null);
});

test('each run of a repeating schedule is named by its date, a one-off by the schedule, and a clash gets a number', () => {
  assert.equal(runName({ name: 'review', when: { time: '09:00', days: WEEKDAYS } }, MON(9), new Set()), 'review-2026-11-02');
  assert.equal(runName({ name: 'review', when: { time: '09:00', days: WEEKDAYS } }, MON(9), new Set(['review-2026-11-02'])), 'review-2026-11-02-2');
  assert.equal(runName({ name: 'nightly', when: { at: MON(22) } }, MON(22), new Set()), 'nightly');
});

test('a schedule needs a prompt, a name, and a time to come or days to repeat on', () => {
  const task = { kind: 'repo', repoId: 1, existingBranch: false, branch: '', path: '', prompt: 'Review open PRs', model: '', effort: '' };
  assert.throws(() => parseSchedule({ name: 'x', task: { ...task, prompt: ' ' }, when: { at: MON(9) } }, MON(8)), /prompt/);
  assert.throws(() => parseSchedule({ name: 'a b', task, when: { at: MON(9) } }, MON(8)), /name/);
  assert.throws(() => parseSchedule({ name: 'x', task, when: { at: MON(7) } }, MON(8)), /passed/);
  assert.throws(() => parseSchedule({ name: 'x', task, when: { time: '9:00', days: [1] } }, MON(8)), /when/);
  assert.throws(() => parseSchedule({ name: 'x', task, when: { time: '09:00', days: [] } }, MON(8)), /day/);
  assert.deepEqual(parseSchedule({ name: 'x', task, when: { time: '09:00', days: [5, 1, 1, 9] } }, MON(8)).when, { time: '09:00', days: [1, 5] });
  assert.throws(() => parseSchedule({ name: 'x', task: { ...task, path: '/w/x' }, when: { time: '09:00', days: [1] } }, MON(8)), /Worktree path/);
  const onBranch = parseSchedule({ name: '', task: { ...task, existingBranch: true, branch: 'feature/a' }, when: { at: MON(9) } }, MON(8));
  assert.equal(onBranch.name, 'feature-a');
});

function setup(schedule: Partial<Schedule>) {
  let clock = MON(8);
  let rows: Schedule[] = [{
    id: 's', name: 'review', task: { kind: 'folder', folder: '/code', prompt: 'p', model: '', effort: '' }, when: { time: '09:00', days: WEEKDAYS },
    next: MON(9), paused: false, last: null, createdAt: 0, ...schedule,
  }];
  const started: { name: string; due: number | null; at: number }[] = [];
  let fail = false;
  const plan = scheduler({
    list: () => rows,
    save: (s) => void (rows = rows.map((r) => (r.id === s.id ? s : r))),
    start: async (_s, name, scheduled) => {
      if (fail) throw new Error('main checkout has uncommitted changes');
      started.push({ name, due: scheduled.due, at: scheduled.at });
      return `task-${started.length}`;
    },
    taken: () => new Set(started.map((s) => s.name)),
    now: () => clock,
  });
  return { plan, started, row: () => rows[0], at: (t: number) => (clock = t), failing: () => (fail = true) };
}

test('nothing starts before a schedule is due; once due it starts and moves on to its next time', async () => {
  const t = setup({});
  await t.plan.step();
  assert.equal(t.started.length, 0);
  t.at(MON(9));
  await t.plan.step();
  assert.deepEqual(t.started, [{ name: 'review-2026-11-02', due: MON(9), at: MON(9) }]);
  assert.equal(t.row().next, local(2026, 11, 3, 9));
  assert.equal(t.row().last?.sessionId, 'task-1');
});

test('runs missed while the Mac slept start once on wake, and the next is the first time after it', async () => {
  const t = setup({});
  t.at(local(2026, 11, 5, 10, 42));
  await t.plan.step();
  await t.plan.step();
  assert.equal(t.started.length, 1);
  assert.deepEqual(t.started[0], { name: 'review-2026-11-02', due: MON(9), at: local(2026, 11, 5, 10, 42) });
  assert.equal(t.row().next, local(2026, 11, 6, 9));
});

test('a one-off runs once, and a paused schedule not at all', async () => {
  const once = setup({ name: 'nightly', when: { at: MON(22) }, next: MON(22) });
  once.at(MON(23));
  await once.plan.step();
  await once.plan.step();
  assert.equal(once.started.length, 1);
  assert.equal(once.row().next, null);
  const paused = setup({ paused: true });
  paused.at(MON(10));
  await paused.plan.step();
  assert.equal(paused.started.length, 0);
});

test('a run that fails to start is kept as the last run and the schedule still moves on', async () => {
  const t = setup({});
  t.failing();
  t.at(MON(9));
  await t.plan.step();
  assert.equal(t.row().last?.error, 'main checkout has uncommitted changes');
  assert.equal(t.row().next, local(2026, 11, 3, 9));
});

test('Run now starts the task without moving the next run', async () => {
  const t = setup({});
  const run = await t.plan.runNow('s');
  assert.equal(run.due, null);
  assert.equal(t.row().next, MON(9));
  assert.equal(t.row().last?.sessionId, 'task-1');
});
