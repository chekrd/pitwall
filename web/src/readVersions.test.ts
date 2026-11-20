import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedSince } from './readVersions.ts';

test('a document is marked changed only when a newer version came after the one last read here, not when never read', () => {
  assert.equal(changedSince(undefined, 3), false);
  assert.equal(changedSince(2, 3), true);
  assert.equal(changedSince(3, 3), false);
  assert.equal(changedSince(4, 3), false);
});
