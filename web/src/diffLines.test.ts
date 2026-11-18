import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePatchFiles } from '@pierre/diffs';
import { codeRef } from './diffLines.ts';

const patch = `diff --git a/cart.ts b/cart.ts
--- a/cart.ts
+++ b/cart.ts
@@ -10,3 +10,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
@@ -40,2 +41,2 @@
-old();
+next();
 end();
`;

const [file] = parsePatchFiles(patch).flatMap((p) => p.files);

test('lines picked in the diff are taken from the version they were picked in, by their numbers in it', () => {
  assert.deepEqual(codeRef(file, { start: 11, end: 12, side: 'additions' }), { path: 'cart.ts', side: 'new', start: 11, end: 12, lines: ['const b = 3;', 'const c = 4;'] });
  assert.deepEqual(codeRef(file, { start: 11, end: 11, side: 'deletions' }).lines, ['const b = 2;']);
  assert.deepEqual(codeRef(file, { start: 42, end: 41, side: 'additions' }), { path: 'cart.ts', side: 'new', start: 41, end: 42, lines: ['next();', 'end();'] }, 'dragged upwards');
  assert.deepEqual(codeRef(file, { start: 12, end: 41, side: 'additions' }).lines, ['const c = 4;', 'export { a };'], 'stops where the diff hides lines');
});
