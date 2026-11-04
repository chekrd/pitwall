import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { limiter, runCommand } from './headless.ts';

test('background runs leave a slot free, and urgent ones go first', async () => {
  const runs = limiter(3);
  const started: string[] = [];
  const take = (name: string, urgent: boolean) => runs.slot(urgent).then((release) => {
    started.push(name);
    return release;
  });
  const b1 = take('b1', false);
  const b2 = take('b2', false);
  const b3 = take('b3', false);
  await sleep(0);
  assert.deepEqual(started, ['b1', 'b2']);
  const u1 = take('u1', true);
  await sleep(0);
  assert.deepEqual(started, ['b1', 'b2', 'u1']);
  const u2 = take('u2', true);
  (await b1)();
  await sleep(0);
  assert.deepEqual(started, ['b1', 'b2', 'u1', 'u2'], 'the urgent run went ahead of the waiting background one');
  (await u1)();
  (await u2)();
  await sleep(0);
  assert.deepEqual(started.at(-1), 'b3');
  (await b2)();
  (await b3)();
  assert.equal(runs.active, 0);
});

test('a run stopped while it waits for a slot leaves the queue', async () => {
  const runs = limiter(2);
  const release = await runs.slot(true);
  const held = await runs.slot(true);
  const controller = new AbortController();
  const waiting = runs.slot(true, controller.signal);
  assert.equal(runs.waiting, 1);
  controller.abort();
  await assert.rejects(waiting, /stopped/);
  assert.equal(runs.waiting, 0);
  release();
  held();
  release();
  assert.equal(runs.active, 0, 'a release counts once');
});

// A stand-in for claude that ignores SIGTERM and leaves a child of its own running.
function stubborn() {
  const dir = mkdtempSync(join(tmpdir(), 'pitwall-headless-'));
  const script = join(dir, 'claude');
  writeFileSync(script, `#!/bin/sh
trap '' TERM
sh -c 'trap "" TERM; sleep 30; touch "${dir}/survived"' &
echo $! > "${dir}/child"
wait
`);
  chmodSync(script, 0o755);
  return { dir, script };
}

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test('stopping a run kills its whole process group, with SIGKILL once the grace period is over', async () => {
  const { dir, script } = stubborn();
  const controller = new AbortController();
  const run = runCommand(script, 'prompt', { cwd: dir, args: [], timeoutMs: 60_000, signal: controller.signal }, 300);
  while (!existsSync(join(dir, 'child'))) await sleep(20);
  const child = Number(readFileSync(join(dir, 'child'), 'utf8'));
  const at = Date.now();
  controller.abort();
  await assert.rejects(run, /stopped/);
  assert.ok(Date.now() - at >= 250, 'SIGKILL waited for the grace period');
  while (!gone(child) && Date.now() - at < 3000) await sleep(20);
  assert.ok(gone(child), 'the grandchild was killed with the group');
});

test('what a run left running in the background goes when Claude ends, so its answer does not wait for it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pitwall-headless-'));
  const script = join(dir, 'claude');
  writeFileSync(script, `#!/bin/sh\nsleep 30 &\necho $! > "${dir}/child"\necho '{"result":"done"}'\n`);
  chmodSync(script, 0o755);
  const at = Date.now();
  assert.deepEqual(await runCommand(script, 'prompt', { cwd: dir, args: [], timeoutMs: 60_000 }, 300), { result: 'done' });
  assert.ok(Date.now() - at < 5000, 'the answer waited for the background process');
  const child = Number(readFileSync(join(dir, 'child'), 'utf8'));
  while (!gone(child) && Date.now() - at < 3000) await sleep(20);
  assert.ok(gone(child));
});

test('a run past its time limit is killed and says it timed out', async () => {
  const { dir, script } = stubborn();
  await assert.rejects(runCommand(script, 'prompt', { cwd: dir, args: [], timeoutMs: 200 }, 100), /timed out/);
});
