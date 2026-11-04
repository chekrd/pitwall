import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveState } from './conversations.ts';
import { Refusal } from './decision.ts';
import { hindrance, pressIn, sendTo, Unsent, type Driver, type Target } from './delivery.ts';
import { PartlyTyped, type Keystroke } from './ghostty.ts';

const target: Target = { pid: 7, tty: '/dev/ttys003', conversation: 'c1' };
const START = 'Wed Nov  4 09:00:00 2026';

const state = (file: Partial<Record<string, unknown>> | null = {}, ps: Partial<NonNullable<LiveState['ps']>> | null = {}): LiveState => ({
  file: file && { sessionId: 'c1', procStart: START, status: 'idle', waitingFor: null, ...file },
  ps: ps && { start: 'Wed Nov 4 09:00:00 2026', tty: '/dev/ttys003', pgid: 7, tpgid: 7, ...ps },
});

test('the terminal still runs that very Claude at its prompt, with nothing else in front of it', () => {
  assert.equal(hindrance(target, state()), null);
  assert.equal(hindrance(target, state({ procStart: undefined })), null, 'a session file without procStart is taken as it is');
  assert.equal(hindrance(target, state({}, null)), 'Claude has quit');
  assert.equal(hindrance(target, state(null)), 'Claude has quit');
  assert.equal(hindrance(target, state({}, { start: 'Wed Nov 4 10:00:00 2026' })), 'Claude has quit', 'its pid is another process now');
  assert.equal(hindrance(target, state({ sessionId: 'c2' })), 'Claude has moved on to another conversation');
  assert.equal(hindrance(target, state({}, { tty: '/dev/ttys009' })), 'Claude runs in another terminal now');
  assert.equal(hindrance(target, state({}, { tpgid: 9 })), 'another program is in the front of its terminal');
  assert.equal(hindrance(target, state({ status: 'waiting', waitingFor: 'permission to run Bash' })), 'Claude is showing permission to run Bash in its terminal');
  assert.equal(hindrance({ ...target, prompt: true }, state({ status: 'waiting' })), null, 'a menu answer answers what Claude shows');
});

// A terminal that logs what goes into it, behind a reader that sees each state in turn, the last one from then on.
function terminal(...states: LiveState[]) {
  const log: string[] = [];
  let reads = 0;
  const d: Driver = {
    paste: async (text) => void log.push(`paste ${text}`),
    keys: async (strokes: Keystroke[]) => void log.push(`keys ${strokes.map((k) => ('key' in k ? k.key : k.text)).join(' ')}`),
  };
  const read = async () => {
    log.push('check');
    return states[Math.min(reads++, states.length - 1)];
  };
  return { d, read, log };
}

test('a send is checked right before its paste and again right before its Enter', async () => {
  const t = terminal(state());
  await sendTo(t.d, target, t.read, 'yes\u0007, go', [], 0);
  assert.deepEqual(t.log, ['check', 'paste yes, go', 'check', 'keys enter']);
  const pictures = terminal(state());
  await sendTo(pictures.d, target, pictures.read, 'look', ['/u/a.png', '/u/notes.txt'], 0);
  assert.deepEqual(pictures.log, ['check', 'paste /u/a.png', 'check', 'paste  /u/notes.txt look', 'check', 'keys enter']);
});

test('a send whose Claude is gone or busy with a prompt before anything went in types nothing and is refused', async () => {
  const t = terminal(state({ status: 'waiting', waitingFor: 'permission to run Bash' }));
  await assert.rejects(sendTo(t.d, target, t.read, 'yes', [], 0), (err) =>
    err instanceof Refusal && err.code === 'stale' && /permission to run Bash.*nothing was typed/.test(err.message));
  assert.deepEqual(t.log, ['check']);
});

test('a send whose terminal changed after the paste presses no Enter, and says the text waits there unsent', async () => {
  const t = terminal(state(), state({}, { tpgid: 9 }));
  await assert.rejects(sendTo(t.d, target, t.read, 'yes', [], 0), (err) =>
    err instanceof Unsent && err instanceof PartlyTyped && /Enter was not pressed.*send or clear it there/.test(err.message));
  assert.deepEqual(t.log, ['check', 'paste yes', 'check']);
});

test('keys are checked before the first one, and none go to a terminal that fails', async () => {
  const ok = terminal(state({ status: 'waiting' }));
  await pressIn(ok.d, { ...target, prompt: true }, ok.read, [{ key: 'arrow_down' }, { text: 'Pur\u001bple' }]);
  assert.deepEqual(ok.log, ['check', 'keys arrow_down Purple']);
  const gone = terminal(state({ sessionId: 'c2' }));
  await assert.rejects(pressIn(gone.d, target, gone.read, [{ key: 'escape' }]), Refusal);
  assert.deepEqual(gone.log, ['check']);
});
