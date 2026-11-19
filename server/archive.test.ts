import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sessions, type SessionStatus } from './db.ts';
import { sync } from './ingest.ts';
import * as S from './sessions.ts';

const CLAUDE_DIR = join(homedir(), '.claude');
let n = 0;

// A stand-in Claude: a live process registered in ~/.claude/sessions as Claude Code registers itself.
async function claude(status: 'idle' | 'busy') {
  const id = `archive-test-${process.pid}-${n++}`;
  const cwd = await mkdtemp(join(tmpdir(), 'archive-'));
  const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const register = (s: string) => writeFile(join(CLAUDE_DIR, 'sessions', `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: id, cwd, kind: 'interactive', entrypoint: 'cli', status: s }));
  await mkdir(join(CLAUDE_DIR, 'sessions'), { recursive: true });
  await register(status);
  sessions.insert({ id, repoId: null, worktree: cwd, cwd, pid: child.pid!, tty: null, title: 'x', firstPrompt: 'never written to a transcript', status: status === 'busy' ? 'working' : 'idle' });
  return { id, child, register };
}

const ended = (child: ChildProcess) => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit'));

async function statusOf(id: string, want: SessionStatus) {
  for (let i = 0; i < 50 && sessions.get(id)!.status !== want; i++) {
    await sync();
    await new Promise((r) => setTimeout(r, 100));
  }
  return sessions.get(id)!.status;
}

test('archiving a task quits its idle Claude, and the task ends archived', async () => {
  const { id, child } = await claude('idle');
  await S.archive(id, true);
  await ended(child);
  assert.equal(child.signalCode, 'SIGTERM');
  assert.equal(await statusOf(id, 'exited'), 'exited');
  assert.equal(sessions.get(id)!.archived, true);
});

test('a Claude archived at work runs on until its turn ends, then quits', async () => {
  const { id, child, register } = await claude('busy');
  await S.archive(id, true);
  await sync();
  assert.equal(child.exitCode ?? child.signalCode, null);
  await register('idle');
  await sync();
  await ended(child);
  assert.equal(child.signalCode, 'SIGTERM');
});

test('Undo right after archiving waits for the quitting Claude to go and only then resumes the conversation', async () => {
  const { id, child } = await claude('idle');
  await S.archive(id, true);
  await S.archive(id, false);
  await ended(child);
  // No transcript, so resuming fails as Continue would; the task is back on the board, ended.
  assert.deepEqual([sessions.get(id)!.status, sessions.get(id)!.archived], ['exited', false]);
});
