import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessions } from './db.ts';

const add = (id: string, worktree = '/w') =>
  sessions.insert({ id, repoId: null, worktree, cwd: worktree, pid: null, tty: null, title: id, firstPrompt: null, status: 'idle' });

test('a session read again unchanged shares its parsed fields, and every write shows at once', () => {
  add('cached');
  sessions.update('cached', { links: [{ url: 'https://a', text: null, context: 'a', about: null, at: 1 }] });
  const first = sessions.get('cached')!;
  const again = sessions.all().find((s) => s.id === 'cached')!;
  assert.notEqual(first, again, 'each caller gets its own copy');
  assert.equal(first.links, again.links, 'the unchanged row was not parsed again');

  again.title = 'changed by a caller';
  assert.equal(sessions.get('cached')!.title, 'cached', "a caller's copy does not leak into the cache");

  // Two writes in one millisecond keep the same updated_at.
  sessions.update('cached', { title: 'one' });
  sessions.update('cached', { title: 'two' });
  assert.equal(sessions.get('cached')!.title, 'two');
  assert.equal(sessions.byConversation('cached')!.title, 'two');

  sessions.update('cached', { links: [] });
  assert.deepEqual(sessions.get('cached')!.links, []);

  sessions.remove('cached');
  assert.equal(sessions.get('cached'), undefined);
  add('cached');
  assert.deepEqual(sessions.get('cached')!.links, [], 'a row inserted again is read afresh');
});

test('removing a worktree\'s sessions drops them from the cache', () => {
  add('in-a', '/a');
  add('in-b', '/b');
  sessions.get('in-a');
  sessions.removeByWorktree('/a');
  assert.equal(sessions.get('in-a'), undefined);
  assert.equal(sessions.get('in-b')!.worktree, '/b');
});
