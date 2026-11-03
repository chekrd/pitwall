import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearings } from './clearing.ts';

function gate() {
  let open!: () => void;
  let fail!: (err: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { done, open, fail };
}

test('the tasks show as clearing while the removal runs, and not after', async () => {
  let changes = 0;
  const c = clearings(() => void changes++);
  const g = gate();
  const run = c.run('/wt/a', ['t1', 't2'], () => g.done);
  assert.deepEqual([c.of('t1'), c.of('t2').clearing, c.of('t3').clearing], [{ clearing: true, clearError: null }, true, false]);
  g.open();
  await run;
  assert.equal(c.of('t1').clearing, false);
  assert.ok(changes >= 2, 'the board hears of the start and the end');
});

test('a second clear of the same path waits for the running one instead of removing it again', async () => {
  const c = clearings(() => {});
  const g = gate();
  let started = 0;
  const work = () => (started++, g.done);
  const first = c.run('/wt/a', ['t1'], work);
  const second = c.run('/wt/a', ['t1'], work);
  let settled = false;
  void second.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(started, 1);
  assert.equal(settled, false, 'the second waits for the first');
  g.open();
  await Promise.all([first, second]);
  await c.run('/wt/a', ['t1'], async () => void started++);
  assert.equal(started, 2, 'a clear after the first finished runs again');
});

test('a failed removal drops the mark, shows its error on every task in it until dismissed or tried again', async () => {
  const c = clearings(() => {});
  const g = gate();
  const run = c.run('/wt/a', ['t1', 't2'], () => g.done);
  g.fail(new Error('Claude did not quit; nothing was deleted'));
  await assert.rejects(run, /did not quit/);
  assert.deepEqual(c.of('t1'), { clearing: false, clearError: 'Claude did not quit; nothing was deleted' });
  c.dismiss('t1');
  assert.equal(c.of('t1').clearError, null);
  assert.equal(c.of('t2').clearError, 'Claude did not quit; nothing was deleted');
  const again = gate();
  const retry = c.run('/wt/a', ['t2'], () => again.done);
  assert.deepEqual(c.of('t2'), { clearing: true, clearError: null }, 'trying again clears the old error');
  again.open();
  await retry;
});

test('a removal that throws before it awaits anything still counts as a failure of the clear', async () => {
  const c = clearings(() => {});
  await assert.rejects(c.run('/wt/a', ['t1'], () => {
    throw new Error('worktree not found');
  }), /worktree not found/);
  assert.equal(c.of('t1').clearError, 'worktree not found');
  assert.equal(c.of('t1').clearing, false);
});
