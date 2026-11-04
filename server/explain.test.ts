import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessions } from './db.ts';
import { settleExplanations } from './explain.ts';

test('an explanation left thinking by a restart fails, so Elaborate can start it again', () => {
  sessions.insert({ id: 'cut', repoId: null, worktree: '/w', cwd: '/w', pid: null, tty: null, title: null, firstPrompt: null, status: 'waiting' });
  sessions.insert({ id: 'done', repoId: null, worktree: '/w', cwd: '/w', pid: null, tty: null, title: null, firstPrompt: null, status: 'waiting' });
  sessions.update('cut', { explanation: { key: 'q:1', state: 'thinking', text: '', at: 1 } });
  sessions.update('done', { explanation: { key: 'q:2', state: 'done', text: 'why', at: 1 } });
  settleExplanations();
  const cut = sessions.get('cut')!.explanation!;
  assert.equal(cut.state, 'failed');
  assert.equal(cut.key, 'q:1');
  assert.match(cut.error ?? '', /restarted/);
  assert.deepEqual(sessions.get('done')!.explanation, { key: 'q:2', state: 'done', text: 'why', at: 1 });
});
