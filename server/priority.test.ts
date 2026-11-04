import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ranks, UNRANKED_REASON } from './priority.ts';

test('every open decision gets one rank: duplicates keep their first place, made-up ids drop, left-out ones come last', () => {
  const order = [
    { id: 'c', reason: 'blocks a release' },
    { id: 'ghost', reason: 'not open' },
    { id: 'a', reason: 'quick to answer' },
    { id: 'c', reason: 'again' },
    { id: 42, reason: 'not an id' },
  ];
  assert.deepEqual(ranks(order, ['a', 'b', 'c', 'd']), [
    { id: 'c', rank: 1, reason: 'blocks a release' },
    { id: 'a', rank: 2, reason: 'quick to answer' },
    { id: 'b', rank: 3, reason: UNRANKED_REASON },
    { id: 'd', rank: 4, reason: UNRANKED_REASON },
  ]);
});

test('a ranking that names none of the open decisions keeps their order', () => {
  assert.deepEqual(ranks([], ['x', 'y']).map((r) => [r.id, r.rank]), [['x', 1], ['y', 2]]);
});
