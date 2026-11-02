import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact, screenOf, scrubName } from './ux.ts';

test('a path reads as the screen it shows: the queue, the Wall, or a task on one of its tabs', () => {
  assert.equal(screenOf('/'), 'queue');
  assert.equal(screenOf('/wall'), 'wall');
  assert.equal(screenOf('/s/abc'), 'task/overview');
  assert.equal(screenOf('/s/abc/diff/web/src/App.tsx'), 'task/diff');
});

test('task names in what the board records read as task, the longest name first so one inside another does not leave a part', () => {
  assert.equal(redact('Not sent to cart-api-v2: gone', ['cart-api', 'cart-api-v2']), 'Not sent to task: gone');
  assert.equal(redact('Open cart-api', ['cart-api-v2', 'cart-api']), 'Open task');
});

test('a name is replaced only whole, so a branch called fix leaves prefix alone', () => {
  assert.equal(redact('Copy branch fix and prefix', ['fix']), 'Copy branch task and prefix');
});

test('what a control names reads without names, paths, ids or tickets', () => {
  assert.equal(scrubName('Open in VS Code ~/git/kontent/worktrees/x/draft_client', []), 'Open in VS Code path');
  assert.equal(scrubName('Copy session id 0abd879f-beb2-47d6-8d8b-c3703e24ea2d', []), 'Copy session id #');
  assert.equal(scrubName('Commit 4c185ffa landed', []), 'Commit # landed');
  assert.equal(scrubName('KCL-15622 custom app', []), 'ticket custom app');
  assert.equal(scrubName('Repository:  ai-eng', ['ai-eng']), 'Repository: task');
  assert.equal(scrubName('Stop scanning ~/code', []), 'Stop scanning path');
  assert.equal(scrubName('5h 34%', []), '#h #%');
});
