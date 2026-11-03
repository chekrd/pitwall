export interface ClearMark {
  clearing: boolean;
  clearError: string | null;
}

// Clear task removes worktrees, which takes minutes for a large checkout, and the tasks stay on the board until it is
// done. A removal already running for the same key is joined, not started again.
export function clearings(changed: () => void) {
  const runs = new Map<string, { ids: Set<string>; done: Promise<void> }>();
  const failed = new Map<string, string>();
  return {
    run(key: string, ids: string[], work: () => Promise<void>): Promise<void> {
      const running = runs.get(key);
      if (running) return running.done;
      for (const id of ids) failed.delete(id);
      const done = Promise.resolve()
        .then(work)
        .then(
          () => {},
          (err: unknown) => {
            for (const id of ids) failed.set(id, err instanceof Error ? err.message : String(err));
            throw err;
          },
        )
        .finally(() => {
          runs.delete(key);
          changed();
        });
      runs.set(key, { ids: new Set(ids), done });
      changed();
      return done;
    },
    of(id: string): ClearMark {
      return { clearing: [...runs.values()].some((r) => r.ids.has(id)), clearError: failed.get(id) ?? null };
    },
    dismiss(id: string) {
      if (failed.delete(id)) changed();
    },
  };
}
