import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ARCHITECTURE_DIR, layout, readModel } from '../server/architecture.ts';
import { installSkills, SKILL_NAMES } from './skills.ts';

const SKILLS = join(import.meta.dirname, '..', 'config', 'skills');

test('connect copies grill-me and architecture to the user\'s skills, naming Pitwall\'s folder in the check command; disconnect removes only those it copied', () => {
  const to = mkdtempSync(join(tmpdir(), 'pitwall-skills-'));
  const warned: string[] = [];
  mkdirSync(join(to, 'mine'));
  installSkills(true, { from: SKILLS, to, pitwall: '/Users/me/pitwall', warn: (m) => warned.push(m) });
  assert.deepEqual(SKILL_NAMES, ['grill-me', 'architecture']);
  const skill = readFileSync(join(to, 'architecture', 'SKILL.md'), 'utf8');
  assert.match(skill, /^name: architecture$/m);
  assert.match(skill, /node \/Users\/me\/pitwall\/scripts\/architecture\.ts check/);
  assert.doesNotMatch(skill, /\{\{PITWALL\}\}/);
  assert.ok(existsSync(join(to, 'grill-me', 'SKILL.md')));
  assert.equal(warned.length, 0);

  installSkills(false, { from: SKILLS, to, pitwall: '/Users/me/pitwall' });
  assert.equal(existsSync(join(to, 'architecture')), false);
  assert.equal(existsSync(join(to, 'grill-me')), false);
  assert.ok(existsSync(join(to, 'mine')));

  mkdirSync(join(to, 'architecture'));
  writeFileSync(join(to, 'architecture', 'SKILL.md'), 'my own');
  installSkills(true, { from: SKILLS, to, pitwall: '/Users/me/pitwall', warn: (m) => warned.push(m) });
  assert.equal(readFileSync(join(to, 'architecture', 'SKILL.md'), 'utf8'), 'my own');
  assert.match(warned.join('\n'), /architecture is a skill of your own, left as it is/);
});

test('the architecture skill\'s example is a model LikeC4 lays out without errors, with a scoped view to drill into', async () => {
  const text = readFileSync(join(SKILLS, 'architecture', 'SKILL.md'), 'utf8');
  const root = mkdtempSync(join(tmpdir(), 'pitwall-skill-example-'));
  mkdirSync(join(root, ARCHITECTURE_DIR), { recursive: true });
  const files = [...text.matchAll(/`(\w+\.c4)`:\n\n```likec4\n([\s\S]*?)```/g)];
  assert.deepEqual(files.map((f) => f[1]), ['spec.c4', 'model.c4', 'views.c4']);
  for (const [, name, body] of files) writeFileSync(join(root, ARCHITECTURE_DIR, name), body);
  const { data, errors } = await layout((await readModel(root))!);
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.values(data!.views).map((v) => [v.id, v.viewOf ?? null]), [['index', null], ['shop', 'shop'], ['api', 'shop.api']]);
});
