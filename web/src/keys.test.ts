import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Kind } from './answers.ts';
import { keyAction, KEYS, rowFor, typingLock, type Decision, type Key, type KeyContext, type Target } from './keys.ts';

const page: Target = { editable: false, control: false, option: false, resizer: false };
const overview = { tab: 'overview' as const, artifacts: false, documents: false, architecture: false, narrowed: false };
const decision = (kind: Kind, patch: Partial<Decision> = {}): Decision => ({ kind, details: kind === 'ask', primary: true, reply: kind !== 'menu', ...patch });
const ctx = (patch: Partial<KeyContext> = {}): KeyContext =>
  ({ sheet: overview, decision: decision('ask'), next: true, guarded: false, held: false, repos: true, target: page, modal: null, popovers: [], tip: false, ...patch });
const wall = (patch: Partial<KeyContext> = {}) => ctx({ sheet: null, decision: null, ...patch });

const CODES: Record<string, string> = { Enter: 'Enter', Escape: 'Escape', ' ': 'Space', '?': 'Slash', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };
const key = (k: string, patch: Partial<Key> = {}): Key => ({ key: k, code: CODES[k] ?? (/^\d$/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`), ...patch });

test('on a decision ⏎ presses its main button, Space shows or hides the details of an ask and W goes to its reply box', () => {
  assert.deepEqual(keyAction(ctx(), key('Enter')), { type: 'primary' });
  assert.equal(keyAction(ctx({ decision: decision('ask', { primary: false }) }), key('Enter')), null, 'nothing to send yet');
  assert.deepEqual(keyAction(ctx(), key(' ')), { type: 'details' });
  assert.equal(keyAction(ctx({ decision: decision('round') }), key(' ')), null, 'a round has no details to hide');
  assert.deepEqual(keyAction(ctx({ decision: decision('round') }), key('w')), { type: 'compose' });
  assert.equal(keyAction(ctx({ decision: decision('menu') }), key('w')), null, 'a menu has no reply box');
  for (const k of ['Enter', ' ', 'w']) assert.equal(keyAction(ctx({ decision: null }), key(k)), null, `${k} with no decision`);
});

test('digits stay the tabs on a decision: options are pressed, not keyed', () => {
  assert.deepEqual(keyAction(ctx(), { key: 'é', code: 'Digit2' }), { type: 'tab', tab: 'conversation' });
  assert.deepEqual(keyAction(ctx(), { key: '3', code: 'Numpad3' }), { type: 'tab', tab: 'diff' });
});

test('D goes to the next decision from the Wall and from a task, when one waits', () => {
  assert.deepEqual(keyAction(wall(), key('d')), { type: 'next' });
  assert.deepEqual(keyAction(ctx({ sheet: { tab: 'diff', artifacts: false, documents: false, architecture: false, narrowed: false } }), key('D')), { type: 'next' });
  assert.equal(keyAction(wall({ next: false }), key('d')), null);
  assert.equal(keyAction(ctx({ guarded: true }), key('d')) !== null, true, 'no answer key, so no guard');
});

test('the keys stay off while guarded (answer keys only), on auto-repeat, with Meta, Ctrl or Alt, in a field, and under a dialog other than the sheet', () => {
  const guarded = ctx({ guarded: true });
  for (const k of ['Enter', 'w']) assert.equal(keyAction(guarded, key(k)), null, `${k} while guarded`);
  assert.deepEqual(keyAction(guarded, key(' ')), { type: 'details' });

  assert.equal(keyAction(ctx(), key('Enter', { repeat: true })), null);
  assert.equal(keyAction(ctx(), key('d', { repeat: true })), null);
  assert.deepEqual(keyAction(ctx({ sheet: { tab: 'diff', artifacts: false, documents: false, architecture: false, narrowed: false } }), key('j', { repeat: true })), { type: 'file', step: 1 });

  for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) assert.equal(keyAction(ctx(), key('z', { [mod]: true })), null, mod);
  assert.equal(keyAction(ctx(), key('1', { isComposing: true })), null);
  assert.equal(keyAction(ctx(), key('Enter', { defaultPrevented: true })), null);
  assert.equal(keyAction(ctx({ target: { ...page, editable: true } }), key('d')), null);
  assert.equal(keyAction(ctx({ target: { ...page, resizer: true } }), key('ArrowLeft')), null);

  const dialog = ctx({ modal: 'other' });
  for (const k of ['z', '?', 'd', 'Escape', '1']) assert.equal(keyAction(dialog, key(k)), null, `${k} under a dialog`);
  assert.deepEqual(keyAction(ctx({ modal: 'keys' }), key('?')), { type: 'keys' }, '? closes Keys');
  assert.equal(keyAction(ctx({ modal: 'keys' }), key('z')), null);
});

test('only the ⋯ menu stops the keys: an open toast or tooltip does not', () => {
  assert.deepEqual(keyAction(ctx({ popovers: ['manual'] }), key('z')), { type: 'undo' });
  assert.deepEqual(keyAction(ctx({ popovers: ['hint', 'manual'] }), key('d')), { type: 'next' });
  assert.equal(keyAction(ctx({ popovers: ['manual', 'auto'] }), key('z')), null);
  assert.equal(keyAction(ctx({ popovers: ['auto'] }), key('?')), null);
});

test('Enter or Space on a focused button is the button\'s; Space on a focused option toggles the details instead', () => {
  const button = ctx({ target: { ...page, control: true } });
  assert.equal(keyAction(button, key('Enter')), null);
  assert.equal(keyAction(button, key(' ')), null);
  assert.deepEqual(keyAction(button, key('w')), { type: 'compose' });
  const option = ctx({ target: { ...page, control: true, option: true } });
  assert.deepEqual(keyAction(option, key(' ')), { type: 'details' });
  assert.equal(keyAction(option, key('Enter')), null, 'Enter on an option clicks it, which sends it');
});

test('Z takes back the last send anywhere, guarded or not', () => {
  assert.deepEqual(keyAction(ctx({ guarded: true }), key('Z')), { type: 'undo' });
  assert.deepEqual(keyAction(wall(), key('z')), { type: 'undo' });
  assert.deepEqual(keyAction(ctx({ sheet: { tab: 'diff', artifacts: false, documents: false, architecture: false, narrowed: false } }), key('z')), { type: 'undo' });
});

test('in a task 1 to 5 switch tabs (4 when there are artifacts, 5 when there are documents), J and K act only on Diff, and Esc goes back', () => {
  const plain = ctx({ decision: null });
  assert.deepEqual(keyAction(plain, { key: '+', code: 'Digit1' }), { type: 'tab', tab: 'overview' });
  assert.deepEqual(keyAction(plain, key('2')), { type: 'tab', tab: 'conversation' });
  assert.deepEqual(keyAction(plain, key('3')), { type: 'tab', tab: 'diff' });
  assert.equal(keyAction(plain, key('4')), null);
  assert.deepEqual(keyAction(ctx({ sheet: { tab: 'overview', artifacts: true, documents: false, architecture: false, narrowed: false } }), key('4')), { type: 'tab', tab: 'artifacts' });
  assert.equal(keyAction(plain, key('5')), null);
  assert.deepEqual(keyAction(ctx({ sheet: { tab: 'overview', artifacts: false, documents: true, architecture: false, narrowed: false } }), key('5')), { type: 'tab', tab: 'documents' });
  assert.equal(keyAction(ctx({ sheet: { tab: 'overview', artifacts: false, documents: true, architecture: false, narrowed: false } }), key('4')), null, 'documents without artifacts');
  assert.equal(keyAction(plain, key('6')), null);
  assert.deepEqual(keyAction(ctx({ sheet: { tab: 'overview', artifacts: false, documents: false, architecture: true, narrowed: false } }), key('6')), { type: 'tab', tab: 'architecture' });
  assert.equal(keyAction(plain, key('7')), null);
  assert.equal(keyAction(plain, key('j')), null);
  const diff = ctx({ sheet: { tab: 'diff', artifacts: false, documents: false, architecture: false, narrowed: false }, decision: null });
  assert.deepEqual(keyAction(diff, key('j')), { type: 'file', step: 1 });
  assert.deepEqual(keyAction(diff, key('K', { repeat: true })), { type: 'file', step: -1 });
  for (const k of ['v', 'Enter', 'ArrowRight', 'w', 'x', 'o']) assert.equal(keyAction(diff, key(k)), null, `${k} in the sheet`);
  assert.deepEqual(keyAction(diff, key('n')), { type: 'new-task' });
  assert.deepEqual(keyAction(diff, key('Escape')), { type: 'back' });
  assert.deepEqual(keyAction(diff, key('?')), { type: 'keys' });
});

test('on the Wall N needs a repository, the tabs and the decision keys do nothing, and Esc only takes back a send', () => {
  assert.deepEqual(keyAction(wall(), key('n')), { type: 'new-task' });
  assert.equal(keyAction(wall({ repos: false }), key('n')), null);
  for (const k of ['1', 'Enter', 'w', ' ', 'j', 'v']) assert.equal(keyAction(wall(), key(k)), null, `${k} on the Wall`);
  assert.equal(keyAction(wall(), key('Escape')), null);
  for (const at of [ctx({ held: true }), wall({ held: true }), ctx({ held: true, sheet: { tab: 'diff', artifacts: false, documents: false, architecture: false, narrowed: false } })]) {
    assert.deepEqual(keyAction(at, key('Escape')), { type: 'undo' }, 'a held send goes back first');
  }
});

test('Esc has one order: a held send goes back first, then a tooltip is dismissed, then one file of the diff steps back to all files, then the task closes; a field keeps its own Esc', () => {
  const file = { tab: 'diff' as const, artifacts: false, documents: false, architecture: false, narrowed: true };
  assert.deepEqual(keyAction(ctx({ sheet: file, held: true, tip: true }), key('Escape')), { type: 'undo' }, 'hovering the Undo toast');
  assert.deepEqual(keyAction(ctx({ sheet: file, held: true }), key('Escape')), { type: 'undo' }, 'over one file of the diff');
  assert.deepEqual(keyAction(ctx({ sheet: file, tip: true }), key('Escape')), { type: 'close', what: 'tooltip' });
  assert.deepEqual(keyAction(ctx({ sheet: file }), key('Escape')), { type: 'close', what: 'file' });
  assert.deepEqual(keyAction(ctx({ sheet: file, target: { ...page, resizer: true } }), key('Escape')), { type: 'close', what: 'file' }, 'on the resize handle');
  assert.deepEqual(keyAction(ctx({ sheet: { ...file, narrowed: false } }), key('Escape')), { type: 'back' });
  assert.equal(keyAction(ctx({ sheet: file, held: true, target: { ...page, editable: true } }), key('Escape')), null, 'the rename field or the filter');
  assert.deepEqual(keyAction(wall({ tip: true }), key('Escape')), { type: 'close', what: 'tooltip' });
  for (const over of [ctx({ modal: 'other', held: true, tip: true }), ctx({ popovers: ['auto', 'hint'], held: true, tip: true })]) {
    assert.deepEqual(keyAction(over, key('Escape')), { type: 'close', what: 'tooltip' }, 'a tooltip over a dialog or menu goes, and the layer stays');
    assert.equal(keyAction({ ...over, tip: false }, key('Escape')), null, 'the layer closes itself');
  }
});

test('every row of the Keys table does something, so the Keys dialog lists exactly what the keys do', () => {
  const samples: Record<string, [KeyContext, Key]> = {
    '↵': [ctx(), key('Enter')],
    Space: [ctx(), key(' ')],
    W: [ctx(), key('w')],
    D: [wall(), key('d')],
    Z: [ctx(), key('z')],
    N: [wall(), key('n')],
    B: [ctx(), key('b')],
    '1 / 2 / 3 / 4 / 5 / 6': [ctx({ sheet: { tab: 'overview', artifacts: true, documents: false, architecture: false, narrowed: false } }), key('4')],
    'J / K': [ctx({ sheet: { tab: 'diff', artifacts: true, documents: false, architecture: false, narrowed: false } }), key('k')],
    Esc: [ctx(), key('Escape')],
    '?': [wall(), key('?')],
  };
  assert.deepEqual(KEYS.map((r) => r.keys), Object.keys(samples));
  for (const row of KEYS) {
    const [c, e] = samples[row.keys];
    assert.ok(row.help, `${row.keys} has no description`);
    assert.equal(rowFor(c, e), row, row.keys);
    assert.notEqual(keyAction(c, e), null, row.keys);
  }
  for (const k of ['e', 'y', 'v', 'x', 'o']) assert.equal(keyAction(ctx(), key(k)), null, `${k} is no key of the board`);
});

test('the typing lock: after a field unmounts under typing, each key only keeps the keys off for another second; a click or Esc ends it', () => {
  let now = 0;
  const lock = typingLock(() => now);
  assert.equal(lock.takes(key('x')), false);
  lock.start();
  now = 900;
  assert.equal(lock.takes(key('w')), true, 'the rest of "we fix 3 x" goes nowhere');
  now = 1800;
  assert.equal(lock.takes(key('3')), true, 'each key keeps it a second longer');
  now = 2700;
  assert.equal(lock.takes(key('x')), true);
  now = 3701;
  assert.equal(lock.locked(), false);
  assert.equal(lock.takes(key('x')), false, 'a pause of a second ends it');
  lock.start();
  lock.end();
  assert.equal(lock.takes(key('z')), false, 'a click ends it');
  lock.start();
  assert.equal(lock.takes(key('Escape')), false, 'Esc ends it and goes through');
  assert.equal(lock.takes(key('z')), false);
});
