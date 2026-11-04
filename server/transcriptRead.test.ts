import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { forgetIndexes, readEntries, readEntriesWhole } from './transcriptRead.ts';

const isPrompt = (e: Record<string, any>) => e?.type === 'user' && typeof e.message?.content === 'string';

function random(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

// Prompts now and then, long stretches of tool output between them, lines over the length limit, multibyte text, a
// line that is not JSON and one that is JSON but no object.
function transcript(rand: () => number, bytes: number) {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const r = rand();
    const line = r < 0.04
      ? JSON.stringify({ type: 'user', uuid: `p${i}`, message: { content: `prompt ${i} — é ✓ 🚀` } })
      : r < 0.1
      ? JSON.stringify({ type: 'user', uuid: `r${i}`, message: { content: [{ type: 'tool_result', content: 'x'.repeat(300_000) }] } })
      : r < 0.2
      ? JSON.stringify({ type: 'assistant', uuid: `a${i}`, message: { content: [{ type: 'text', text: `ünïcödé ${'ж'.repeat(Math.floor(rand() * 60_000))}` }] } })
      : r < 0.21
      ? 'not json at all'
      : r < 0.215
      ? 'null'
      : JSON.stringify({ type: 'assistant', uuid: `s${i}`, message: { content: [{ type: 'text', text: `step ${i}` }] } });
    lines.push(line);
    size += Buffer.byteLength(line) + 1;
  }
  return Buffer.from(`${lines.join('\n')}\n`);
}

async function same(file: string, label: string) {
  const whole = await readEntriesWhole(file, isPrompt);
  const read = await readEntries(file, isPrompt);
  assert.deepEqual(read, whole, label);
}

test('a transcript read as it grows, cut anywhere, gives what reading it whole gives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pitwall-tail-'));
  const rand = random(7);
  const content = transcript(rand, 11 << 20);
  const file = join(dir, 't.jsonl');
  writeFileSync(file, '');
  let at = 0;
  for (let step = 0; at < content.length; step++) {
    const chunk = Math.max(1, Math.floor(rand() ** 3 * 900_000));
    appendFileSync(file, content.subarray(at, Math.min(content.length, at + chunk)));
    at += chunk;
    // Now and then as after the board restarted, so the first read of a large file reaches back past its first window.
    if (step % 7 === 6) forgetIndexes();
    await same(file, `after ${Math.min(at, content.length)} bytes, step ${step}`);
  }
});

test('a transcript rewritten, shrunk or replaced is read afresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pitwall-tail-'));
  const rand = random(11);
  const file = join(dir, 't.jsonl');
  const first = transcript(rand, 3 << 20);
  writeFileSync(file, first);
  await same(file, 'first');
  writeFileSync(file, first.subarray(0, first.length >> 1));
  await same(file, 'shrunk');
  const other = transcript(rand, 3 << 20);
  writeFileSync(file, other);
  await same(file, 'rewritten in place, bigger');
  writeFileSync(join(dir, 'new.jsonl'), Buffer.concat([other, transcript(rand, 1 << 20)]));
  renameSync(join(dir, 'new.jsonl'), file);
  await same(file, 'replaced by a longer file');
});

// The rest of a line can be JSON too, as the digits of a number, so the line a window starts in must be read as it is.
test('a window that starts inside a line keeps what is left of it, read whole or as the file grew', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pitwall-tail-')), 't.jsonl');
  const step = (i: number) => `${JSON.stringify({ type: 'assistant', uuid: `s${i}`, pad: 'y'.repeat(200) })}\n`;
  const before = Array.from({ length: 50 }, (_, i) => step(i)).join('');
  const prompt = `${JSON.stringify({ type: 'user', uuid: 'p', message: { content: 'go' } })}\n`;
  const number = '1234567890\n';
  let filler = prompt;
  for (let i = 0; Buffer.byteLength(filler) < (512 << 10) - 8 - 300; i++) filler += step(1000 + i);
  filler += `${JSON.stringify({ type: 'x', pad: 'z'.repeat((512 << 10) - 8 - Buffer.byteLength(filler) - 22) })}\n`;
  assert.equal(Buffer.byteLength(filler), (512 << 10) - 8);
  writeFileSync(file, before + number + filler.slice(0, 1000));
  await same(file, 'before it grew');
  writeFileSync(file, before + number + filler);
  const { tail } = await readEntriesWhole(file, isPrompt);
  assert.equal(tail[0], 4567890, 'the window starts three digits into the number');
  await same(file, 'grown');
  forgetIndexes();
  await same(file, 'read afresh');
});

test('the fixture transcript read in pieces matches reading it whole', async () => {
  forgetIndexes();
  const content = readFileSync(join(import.meta.dirname, 'fixtures', 'claude-2.1.314', 'transcript.jsonl'));
  const file = join(mkdtempSync(join(tmpdir(), 'pitwall-tail-')), 't.jsonl');
  writeFileSync(file, '');
  for (let at = 0; at < content.length; at += 997) {
    appendFileSync(file, content.subarray(at, at + 997));
    await same(file, `after ${at + 997} bytes`);
  }
});
