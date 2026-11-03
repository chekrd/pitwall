import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asking, MAX_ASIDES } from './asides.ts';
import type { Aside, Session } from './db.ts';

const session = (patch: Partial<Session> = {}): Session => ({
  id: 's', conversation: 'c-main', history: [], repoId: 1, worktree: '/w', cwd: '/w', pid: 1, tty: '/dev/ttys1', title: null, firstPrompt: null, status: 'working',
  question: null, rank: null, rankReason: null, priority: null, diffstat: null, lastMessage: null, lastPrompt: null, lastTurn: 't2', waitingFor: null,
  dismissedAsk: null, advice: null, prs: [], summary: null, explanation: null, activity: null, menu: null, answered: null, artifacts: [], links: [], findings: null, parent: null, resolution: null, model: null, effort: null, interrupted: null, turnError: null, scheduled: null, parked: [], asides: [],
  archived: false, createdAt: 0, updatedAt: 0, ...patch,
});

function setup(o: { fail?: string } = {}) {
  let row = session();
  const runs: { prompt: string; fork: string | null }[] = [];
  const discarded: string[] = [];
  const pending: (() => void)[] = [];
  const a = asking({
    get: () => row,
    save: (_, asides: Aside[]) => void (row = { ...row, asides }),
    run: (_s, prompt, fork, signal) => new Promise((done, fail) => {
      runs.push({ prompt, fork });
      signal.addEventListener('abort', () => fail(new Error('stopped')));
      pending.push(() => (o.fail ? fail(new Error(o.fail)) : done({ fork: fork ?? `f${runs.length}`, answer: `answer ${runs.length}` })));
    }),
    discard: async (_s, fork) => void discarded.push(fork),
  });
  const settle = async () => {
    for (const p of pending.splice(0)) p();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { a, runs, discarded, settle, row: () => row };
}

test('a question forks the conversation; a follow-up resumes that fork, and the main session is never touched', async () => {
  const t = setup();
  const id = t.a.ask('s', { text: ' Why integer cents? ' });
  assert.equal(t.row().asides[0].state, 'thinking');
  await t.settle();
  assert.deepEqual(t.runs.map((r) => r.fork), [null]);
  assert.match(t.runs[0].prompt, /side question[^]*do not change anything[^]*Question: Why integer cents\?$/);
  assert.deepEqual(t.row().asides[0], { ...t.row().asides[0], fork: 'f1', state: 'done' });
  assert.equal(t.row().asides[0].turns[0].answer, 'answer 1');

  assert.equal(t.a.ask('s', { text: 'And rounding?', aside: id }), id);
  assert.throws(() => t.a.ask('s', { text: 'Again?', aside: id }), /wait for the answer/);
  await t.settle();
  assert.deepEqual(t.runs.map((r) => r.fork), [null, 'f1']);
  assert.match(t.runs[1].prompt, /^A follow-up side question/);
  assert.deepEqual(t.row().asides[0].turns.map((x) => [x.question, x.answer]), [['Why integer cents?', 'answer 1'], ['And rounding?', 'answer 2']]);
});

test('closing an aside removes its fork; one closed while answering discards the fork once it is back', async () => {
  const t = setup();
  const a1 = t.a.ask('s', { text: 'One?' });
  await t.settle();
  await t.a.close('s', a1);
  assert.deepEqual([t.row().asides, t.discarded], [[], ['f1']]);
  const a2 = t.a.ask('s', { text: 'Two?' });
  await t.a.close('s', a2);
  await t.settle();
  assert.deepEqual(t.row().asides, []);
});

test('a failed or stopped answer says so and can be asked again', async () => {
  const t = setup({ fail: 'claude -p timed out' });
  const id = t.a.ask('s', { text: 'Slow?' });
  await t.settle();
  assert.deepEqual([t.row().asides[0].state, t.row().asides[0].turns[0].error], ['failed', 'claude -p timed out']);
  const u = setup();
  const other = u.a.ask('s', { text: 'Stop me' });
  u.a.stop('s', other);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(u.row().asides[0].turns[0].error, 'stopped');
  assert.equal(t.a.ask('s', { text: 'Retry', aside: id }), id, 'a failed aside takes another question');
});

test('empty questions and too many asides are refused, and asides left answering by a restart fail', () => {
  const t = setup();
  assert.throws(() => t.a.ask('s', { text: '  ' }), /empty/);
  for (let i = 0; i < MAX_ASIDES; i++) t.a.ask('s', { text: `q${i}` });
  assert.throws(() => t.a.ask('s', { text: 'one more' }), /at most/);
  const fresh = setup();
  const stuck = { ...t.row() };
  const restarted = asking({ get: () => stuck, save: (_, asides) => void (stuck.asides = asides), run: async () => ({ fork: 'x', answer: 'y' }), discard: async () => {} });
  restarted.settle([stuck]);
  assert.ok(stuck.asides.every((a) => a.state === 'failed' && /restarted/.test(a.turns[0].error!)));
  assert.equal(fresh.row().asides.length, 0);
});

test("a task going away deletes its asides' forks, also one that comes back after it went", async () => {
  const t = setup();
  t.a.ask('s', { text: 'Done one?' });
  await t.settle();
  t.a.ask('s', { text: 'Still answering?' });
  const gone = t.row();
  await t.a.drop(gone);
  assert.deepEqual(t.discarded, ['f1']);
  const u = setup();
  let row: Session | undefined = session();
  const late: (() => void)[] = [];
  const discarded: string[] = [];
  const a = asking({
    get: () => row,
    save: (_, asides) => void (row = row && { ...row, asides }),
    run: () => new Promise((done) => late.push(() => done({ fork: 'f-late', answer: 'x' }))),
    discard: async (_s, fork) => void discarded.push(fork),
  });
  a.ask('s', { text: 'Slow?' });
  row = undefined;
  for (const l of late) l();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(discarded, ['f-late'], 'the fork of a removed task is not left behind');
  assert.equal(u.row().asides.length, 0);
});
