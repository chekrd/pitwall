interface Listed {
  path: string;
  worktrees: readonly { path: string; isMain: boolean }[];
}

// A path registered as a repository can later hold a linked worktree of another one, as when a clone a scan found in a
// task folder is replaced by a worktree at the same path. Git then lists that repository's worktrees from both paths,
// so each would show twice; the path counts as a repository only while it is its own main checkout.
export function ownCheckouts<R extends Listed>(repos: R[]): R[] {
  const paths = new Set(repos.map((r) => r.path));
  return repos.filter((r) => {
    const main = r.worktrees.find((w) => w.isMain)?.path;
    return !main || main === r.path || !paths.has(main);
  });
}
