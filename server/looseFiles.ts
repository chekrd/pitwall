import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Finder writes .DS_Store into any folder it shows; it holds no work.
const NOT_WORK = new Set(['.DS_Store']);

// The files in a task folder outside the worktrees given, and whether a repository lies among them at any depth.
// `.pitwall/` is not counted: it goes unannounced, as it does with a worktree, whose git ignores it.
export async function looseFiles(dir: string, worktrees: Set<string>): Promise<{ files: number; repository: boolean }> {
  let files = 0;
  let repository = false;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, e.name);
    if (worktrees.has(path) || (e.name === '.pitwall' && e.isDirectory())) continue;
    if (e.name === '.git') {
      repository = true;
    } else if (e.isDirectory()) {
      const inner = await looseFiles(path, worktrees);
      files += inner.files;
      repository ||= inner.repository;
    } else if (!NOT_WORK.has(e.name)) {
      files++;
    }
  }
  return { files, repository };
}
