import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markable, occurrences } from './sameText.ts';

test('a picked name is found only as a whole name, $ included', () => {
  assert.deepEqual(occurrences('const id = width + id; $id(id)', 'id'), [[6, 8], [19, 21], [27, 29]]);
});

test('picked text that is not a name is found as written, its regex characters taken literally', () => {
  assert.deepEqual(occurrences('a.b(c) ab a.b(c)', 'a.b(c)'), [[0, 6], [10, 16]]);
  assert.deepEqual(occurrences('x  = y', ' = '), [[2, 5]]);
});

test('only text on one line that is not blank is marked', () => {
  assert.equal(markable('foo'), true);
  assert.equal(markable('  '), false);
  assert.equal(markable('a\nb'), false);
  assert.equal(markable('x'.repeat(201)), false);
});
