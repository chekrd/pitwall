import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoundAnswers } from './rounds.ts';

const memory = () => {
  const kept = new Map<string, string>();
  return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
};

const own = (text: string) => ({ option: null, recommended: false, text });

test("a round's answers are kept by decision, a reload and a closed window too, and whoever shows the round hears of a change", () => {
  const storage = memory();
  const answers = createRoundAnswers(storage);
  let heard = 0;
  const off = answers.subscribe(() => void heard++);
  assert.deepEqual(answers.of('r:a'), {});
  assert.equal(answers.of('r:a'), answers.of(null), 'no answers is the same object each time');
  answers.set('r:a', { Q1: own('phone') });
  off();
  answers.set('r:b', { Q1: own('desk') });
  assert.equal(heard, 1);
  const reloaded = createRoundAnswers(storage);
  assert.deepEqual([reloaded.of('r:a'), reloaded.of('r:b')], [{ Q1: own('phone') }, { Q1: own('desk') }]);
});

test('only the latest rounds are kept, and a page without storage keeps them in memory', () => {
  const answers = createRoundAnswers(null);
  for (let i = 0; i < 31; i++) answers.set(`r:${i}`, { Q1: own(String(i)) });
  answers.set('r:1', { Q1: own('again') });
  assert.deepEqual([answers.of('r:0'), answers.of('r:1'), answers.of('r:30')], [{}, { Q1: own('again') }, { Q1: own('30') }]);
});
