import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handOver, leftBy, taskOf } from './handover.ts';

const task = (id: string, o: { conversation?: string; history?: string[]; pid?: number | null; status?: 'idle' | 'exited' } = {}) => ({
  id, conversation: o.conversation ?? id, history: (o.history ?? []).map((h) => ({ id: h, lastMessage: null, until: 0 })),
  pid: o.pid ?? null, status: o.status ?? 'idle',
});

test('a conversation belongs to the task that runs it, or to one that ran it before a /clear', () => {
  const tasks = [task('a', { conversation: 'a2', history: ['a'] }), task('b')];
  assert.equal(taskOf(tasks, 'a2')?.id, 'a');
  assert.equal(taskOf(tasks, 'a')?.id, 'a');
  assert.equal(taskOf(tasks, 'b')?.id, 'b');
  assert.equal(taskOf(tasks, 'c'), undefined);
});

test('the task a Claude left is the live one on its pid whose conversation is no longer live', () => {
  const tasks = [task('a', { pid: 7 }), task('b', { pid: 8 }), task('old', { pid: 7, status: 'exited' })];
  assert.equal(leftBy(tasks, 7, new Set(['new']))?.id, 'a');
  assert.equal(leftBy(tasks, 7, new Set(['a', 'new'])), undefined);
  assert.equal(leftBy(tasks, 9, new Set(['new'])), undefined);
});

test('a hand-over keeps the old conversation as history and drops only what its transcript said', () => {
  const summary = { text: 'Parser done.', progress: ['Parser'], learnings: ['The lexer is shared.'], findings: 2, basis: 't1', at: 1 };
  const s = { conversation: 'a', history: [], lastMessage: 'Done with the parser.', summary };
  const patch = handOver(s, 'a2', 5);
  assert.deepEqual(patch.history, [{ id: 'a', lastMessage: 'Done with the parser.', until: 5 }]);
  assert.equal(patch.conversation, 'a2');
  assert.deepEqual([patch.lastMessage, patch.lastTurn, patch.question, patch.menu], [null, null, null, null]);
  assert.deepEqual(patch.summary, { ...summary, text: '', progress: [], learnings: [] });
  for (const kept of ['title', 'firstPrompt', 'artifacts', 'links', 'findings', 'parent']) assert.ok(!(kept in patch), kept);
  const back = handOver({ conversation: 'a2', history: patch.history, lastMessage: null, summary: null }, 'a', 9);
  assert.deepEqual(back.history, [{ id: 'a2', lastMessage: null, until: 9 }]);
});

// What each sync does with the live conversations, as syncLive does: the task of each takes it, a Claude that left its
// task by /clear hands it over, and any other conversation becomes a task of its own.
function sync(tasks: ReturnType<typeof task>[], live: Map<string, number>, cleared: ReadonlySet<string> = new Set()) {
  const ids = new Set(live.keys());
  for (const [conversation, pid] of live) {
    let s = taskOf(tasks, conversation, ids);
    if (!s) {
      const left = leftBy(tasks, pid, ids);
      if (!left || !cleared.has(conversation)) {
        tasks.push(task(`new-${conversation}`, { conversation, pid }));
        continue;
      }
      s = left;
    }
    if (s.conversation !== conversation) Object.assign(s, handOver({ ...s, lastMessage: null, summary: null }, conversation, 0));
    s.pid = pid;
  }
}

test("a conversation from a task's history resumed elsewhere does not take the task back while it runs another, sync after sync", () => {
  const a = task('a', { conversation: 'y', history: ['x'], pid: 7 });
  const tasks = [a];
  const conversations: string[] = [];
  for (let i = 0; i < 3; i++) {
    sync(tasks, new Map([['y', 7], ['x', 8]]));
    conversations.push(a.conversation);
  }
  assert.deepEqual(conversations, ['y', 'y', 'y']);
  assert.deepEqual(a.history.map((h) => h.id), ['x']);
  assert.deepEqual(tasks.map((t) => [t.id, t.conversation, t.pid]), [['a', 'y', 7], ['new-x', 'x', 8]]);
});

test("a /resume into another task's earlier conversation leaves that task alone while it runs; one into its own brings it back", () => {
  const a = task('a', { conversation: 'y', history: ['x'], pid: 7 });
  const b = task('b', { pid: 9 });
  const tasks = [a, b];
  for (let i = 0; i < 3; i++) sync(tasks, new Map([['y', 7], ['x', 9]]));
  assert.deepEqual(tasks.map((t) => [t.id, t.conversation]), [['a', 'y'], ['b', 'b'], ['new-x', 'x']]);
  const c = task('c', { conversation: 'z', history: ['w'], pid: 5 });
  sync([c], new Map([['w', 5]]));
  assert.deepEqual([c.conversation, c.history.map((h) => h.id)], ['w', ['z']]);
});
