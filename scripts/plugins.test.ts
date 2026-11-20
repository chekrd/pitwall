import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installRpi, type Claude } from './plugins.ts';

const HUMANLAYER = { name: 'skills', source: 'github', repo: 'humanlayer/skills', installLocation: '/Users/me/.claude/plugins/marketplaces/skills' };
const OFFICIAL = { name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official' };
const RPI = { id: 'rpi@skills', version: '1.1.0', scope: 'user', enabled: true };

// A CLI whose lists answer what it has, and which records every other command it runs.
function cli(have: { markets?: object[]; plugins?: object[]; fails?: string } = {}) {
  const ran: string[] = [];
  const claude: Claude = (args) => {
    const line = args.join(' ');
    if (have.fails && line.startsWith(have.fails)) throw Object.assign(new Error(`Command failed: claude ${line}`), { stderr: 'Error: could not reach github.com\n' });
    if (line === 'plugin marketplace list --json') return JSON.stringify(have.markets ?? []);
    if (line === 'plugin list --json') return JSON.stringify(have.plugins ?? []);
    ran.push(line);
    return '';
  };
  return { claude, ran };
}

test('connect adds the humanlayer marketplace and installs rpi for the user when neither is there', () => {
  const { claude, ran } = cli({ markets: [OFFICIAL] });
  assert.deepEqual(installRpi(claude), { ok: true, said: 'installed the rpi@skills plugin' });
  assert.deepEqual(ran, ['plugin marketplace add --scope user humanlayer/skills', 'plugin install --scope user rpi@skills']);
});

test('connect again changes nothing: the marketplace and the plugin are there', () => {
  const { claude, ran } = cli({ markets: [OFFICIAL, HUMANLAYER], plugins: [RPI] });
  assert.deepEqual(installRpi(claude), { ok: true, said: 'rpi@skills was already installed' });
  assert.deepEqual(ran, []);
});

test('a marketplace already added only gets the plugin; a plugin installed for a project alone is installed for the user', () => {
  const { claude, ran } = cli({ markets: [HUMANLAYER], plugins: [{ ...RPI, scope: 'project' }] });
  assert.equal(installRpi(claude).ok, true);
  assert.deepEqual(ran, ['plugin install --scope user rpi@skills']);
});

test('a disabled plugin is left disabled and said so', () => {
  const { claude, ran } = cli({ markets: [HUMANLAYER], plugins: [{ ...RPI, enabled: false }] });
  assert.deepEqual(installRpi(claude), { ok: true, said: 'rpi@skills is installed but disabled; claude plugin enable rpi@skills turns it on' });
  assert.deepEqual(ran, []);
});

test('another marketplace named skills is not replaced, and rpi is not installed from it', () => {
  const { claude, ran } = cli({ markets: [{ name: 'skills', source: 'github', repo: 'someone/skills' }] });
  assert.deepEqual(installRpi(claude), { ok: false, said: 'rpi not installed: the marketplace named skills is not humanlayer/skills' });
  assert.deepEqual(ran, []);
});

test('a failure is reported, not thrown, so the rest of connect goes on', () => {
  const add = cli({ fails: 'plugin marketplace add' });
  assert.deepEqual(installRpi(add.claude), { ok: false, said: 'rpi not installed: Error: could not reach github.com' });
  const install = cli({ markets: [HUMANLAYER], fails: 'plugin install' });
  assert.equal(installRpi(install.claude).ok, false);
  const garbled = installRpi(() => 'not json');
  assert.equal(garbled.ok, false);
  assert.match(garbled.said, /^rpi not installed: /);
});
