import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bugPrompt, stampOf } from './bugReport.ts';

test('the prompt keeps the comment exactly as written, backticks and blank lines included, inside a fence longer than any run in it', () => {
  const comment = '  The card jumped ```twice``` when I pressed ↵\n\nand `Z` did nothing.  ';
  const prompt = bugPrompt(comment, '/up/bug.json');
  assert.ok(prompt.includes(`\`\`\`\`\n${comment}\n\`\`\`\``));
  assert.match(prompt, /The report is \/up\/bug\.json \(JSON\)/);
  assert.match(prompt, /If the evidence does not explain what went wrong, stop and tell me so/);
  assert.match(prompt, /Reproduce the bug in pnpm e2e, fix it, and deliver the fix to main/);
});

test('with no comment, the prompt says so and leans on the report', () => {
  const prompt = bugPrompt('  \n', '/up/bug.json');
  assert.match(prompt, /I wrote nothing about it/);
  assert.doesNotMatch(prompt, /```/);
});

test('a report is stamped month, day, hours, minutes and seconds', () => {
  assert.equal(stampOf(new Date('2026-11-02T09:22:22.123Z')), '1102092222');
});
