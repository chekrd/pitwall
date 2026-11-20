import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, sep } from 'node:path';
import { after, test } from 'node:test';
import { artifactFile, storeArtifacts } from './artifacts.ts';
import { SESSIONS_DIR } from './config.ts';
import type { Session } from './db.ts';

// Only under a HOME that scripts/isolate.ts made: a real folder named by mkdtemp, with TMPDIR inside it. Comparing
// paths with the account's home would let it through under another name, such as /System/Volumes/Data/Users/<name>,
// and an empty HOME leaves every state path relative to the working folder.
const home = process.env.HOME ?? '';
const isolated = isAbsolute(home) && /^pitwall-home-[A-Za-z0-9]{6}$/.test(basename(home)) && process.env.TMPDIR === join(home, 'tmp') &&
  !!lstatSync(home, { throwIfNoEntry: false })?.isDirectory() && SESSIONS_DIR.startsWith(home + sep);
if (!isolated) {
  throw new Error(`refusing to write artifacts under ${SESSIONS_DIR}: HOME (${JSON.stringify(home)}) is not a folder scripts/isolate.ts made; run the tests with pnpm test`);
}

const id = `test-${randomUUID()}`;
after(() => rm(join(SESSIONS_DIR, id), { recursive: true, force: true }));

const session = (artifacts: Session['artifacts']) => ({ id, artifacts }) as Session;
const call = (toolUseId: string, title: string, at: number, html = `<p>${toolUseId}</p>`) => ({ toolUseId, input: { title, html }, at });

test('an artifact is saved once, and a later one with the same title is its next version, every version kept', async () => {
  const first = await storeArtifacts(session([]), [call('a1', 'Flow', 1), call('b1', 'States', 2)]);
  assert.deepEqual(first?.map((a) => [a.id, a.version]), [['a1', 1], ['b1', 1]]);
  assert.equal(await readFile(artifactFile(id, 'a1'), 'utf8'), '<p>a1</p>');
  assert.equal(await storeArtifacts(session(first), [call('a1', 'Flow', 1), call('b1', 'States', 2)]), null);

  const again = await storeArtifacts(session(first), [call('a1', 'Flow', 1), call('b1', 'States', 2), call('a2', 'Flow', 3), call('a3', 'Flow', 4)]);
  assert.deepEqual(again?.map((a) => [a.id, a.title, a.version]), [['a1', 'Flow', 1], ['b1', 'States', 1], ['a2', 'Flow', 2], ['a3', 'Flow', 3]]);
  assert.equal(await readFile(artifactFile(id, 'a1'), 'utf8'), '<p>a1</p>', 'the first version stays');
  assert.equal(await readFile(artifactFile(id, 'a3'), 'utf8'), '<p>a3</p>');
  assert.equal(await storeArtifacts(session(again), [call('a1', 'Flow', 1), call('a2', 'Flow', 3), call('a3', 'Flow', 4)]), null);
});

test('a call older than a version kept, replaced before versions were, does not come back; versions go with the task folder', async () => {
  const before = [{ id: 'n2', title: 'Flow', at: 5, version: 1 }];
  assert.equal(await storeArtifacts(session(before), [call('n1', 'Flow', 4), call('n2', 'Flow', 5)]), null);
  const many = await storeArtifacts(session([]), Array.from({ length: 30 }, (_, i) => call(`m${i}`, 'Many', 10 + i)));
  assert.equal(many?.at(-1)?.version, 30, 'no cap');
  await rm(join(SESSIONS_DIR, id), { recursive: true, force: true });
  await assert.rejects(readFile(artifactFile(id, 'm0')));
});

test('a call the MCP server would reject is not stored', async () => {
  assert.equal(await storeArtifacts(session([]), [{ toolUseId: 'bad', input: { title: 'No html' }, at: 1 }]), null);
  assert.throws(() => artifactFile(id, '../state'));
});
