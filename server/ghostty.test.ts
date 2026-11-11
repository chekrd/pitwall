import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { closeTerminalsIn, focus, io, keys, newTab, paste } from './ghostty.ts';

// Ghostty is played here as macOS treats it: a script that tells it anything launches it when it is not running.
let isRunning = false;
let launches = 0;
let told: string[] = [];
beforeEach(() => {
  isRunning = false;
  launches = 0;
  told = [];
  io.osascript = async (source) => {
    if (source === 'application "Ghostty" is running') return String(isRunning);
    assert.match(source, /tell application "Ghostty"/);
    if (!isRunning) launches++;
    isRunning = true;
    told.push(source);
    return '';
  };
});

test('clearing a task leaves a Ghostty that is not running alone', async () => {
  assert.equal(await closeTerminalsIn('/work/task', ['/dev/ttys001']), 0);
  assert.equal(launches, 0, 'Ghostty was launched to close tabs it cannot have');
});

test('reaching a tab does not launch Ghostty', async () => {
  await assert.rejects(focus('/dev/ttys001'), /no Ghostty tab runs \/dev\/ttys001/);
  await assert.rejects(paste('/dev/ttys001', 'hello'), /no Ghostty tab runs \/dev\/ttys001/);
  await assert.rejects(keys('/dev/ttys001', [{ key: 'enter' }]), /no Ghostty tab runs \/dev\/ttys001/);
  assert.equal(launches, 0);
});

test('a running Ghostty is asked for its terminals, and a new tab launches it', async () => {
  isRunning = true;
  assert.equal(await closeTerminalsIn('/work/task', []), 0);
  assert.equal(told.length, 1);
  isRunning = false;
  await newTab('/work/task', 'claude');
  assert.equal(launches, 1);
});
