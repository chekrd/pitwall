import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uploadedImages, uploadsDir } from './uploadPaths.ts';

test('a picture uploaded on the board that reached Claude as its path reads as a picture; other files and paths stay text', () => {
  const dir = uploadsDir('/Users/me');
  assert.deepEqual(uploadedImages(`like what?\n\n${dir}/0db1/image.png\n${dir}/0db1/notes.txt ${dir}/0db1/image.png`, '/Users/me'), {
    text: `like what?\n\n${dir}/0db1/notes.txt`,
    images: ['0db1/image.png'],
  });
  assert.deepEqual(uploadedImages(`${dir}/a/Shot.JPEG /tmp/x.png ~/Library/Caches/pitwall/uploads/b/y.png`, '/Users/me'), {
    text: '/tmp/x.png ~/Library/Caches/pitwall/uploads/b/y.png',
    images: ['a/Shot.JPEG'],
  });
  assert.deepEqual(uploadedImages(`${dir}/a/image.png`, ''), { text: `${dir}/a/image.png`, images: [] });
});
