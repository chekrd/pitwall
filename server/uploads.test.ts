import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { UPLOADS_DIR } from './config.ts';
import { keepUploads, pruneUploads, saveUpload } from './uploads.ts';

function upload(name: string, daysOld: number) {
  const dir = join(UPLOADS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'page.png'), 'x');
  const at = new Date(Date.now() - daysOld * 86_400_000);
  utimesSync(dir, at, at);
  return dir;
}

test('an upload leaves old uploads alone; the clean-up prunes those over 30 days old, but for what a schedule still holds', async () => {
  const old = upload('old', 40);
  const held = upload('held', 40);
  const recent = upload('recent', 2);
  keepUploads(() => [join(held, 'page.png')]);

  const saved = await saveUpload('shot.png', new TextEncoder().encode('png').buffer);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(saved));
  assert.ok(existsSync(old), 'saving does not prune');

  await pruneUploads();
  assert.equal(existsSync(old), false);
  assert.ok(existsSync(held), 'kept for its schedule');
  assert.ok(existsSync(recent));
  assert.ok(existsSync(saved));
});
