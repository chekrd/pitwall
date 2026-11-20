import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invocation, knowsCommand, rpiInvocation } from './slash.ts';

// As listCommands names them: a plugin's skills with their plugin's name in front.
const plugin = [{ name: 'compact' }, { name: 'review' }, { name: 'rpi:rpi' }, { name: 'plugin:deploy' }];
const own = [{ name: 'rpi' }, { name: 'compact' }, { name: 'rpi:rpi' }];

test('rpi is invoked by its bare name when a command or skill of that name is listed, else by the name its plugin gives it', () => {
  assert.equal(rpiInvocation(plugin), '/rpi:rpi');
  assert.equal(rpiInvocation(own), '/rpi');
  assert.equal(rpiInvocation([{ name: 'compact' }]), '/rpi', 'neither listed');
  assert.equal(invocation(plugin, 'deploy', 'plugin'), '/plugin:deploy');
});

test('a /rpi typed or sent is a command with either listing, by its bare name or its plugin\'s, and so are other plugins\' commands', () => {
  for (const list of [plugin, own]) {
    assert.ok(knowsCommand(list, '/rpi research .pitwall/artifacts/x; flow: prd'));
    assert.ok(knowsCommand(list, '/rpi:rpi update .pitwall/artifacts/x/04-tdd-x.md\n\n> quote\n\nComment'));
  }
  assert.ok(knowsCommand(plugin, '/deploy now'));
  assert.ok(knowsCommand(plugin, '/plugin:deploy now'));
  assert.equal(knowsCommand(plugin, '/rp is wrong'), false);
  assert.equal(knowsCommand(plugin, '/etc/hosts is wrong'), false);
  assert.equal(knowsCommand(plugin, 'rpi research'), false, 'not a slash command');
  assert.equal(knowsCommand([], '/rpi'), false);
});
