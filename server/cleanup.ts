export interface CleanupJob {
  name: string;
  run: () => unknown;
}

export interface CleanupDeps {
  every?: number;
  timers?: { setInterval: (fn: () => void, ms: number) => { unref?: () => unknown }; clearInterval: (t: any) => void };
  warn?: (message: string, err: unknown) => void;
}

export const CLEANUP_MS = 3600_000;

// What the server clears on its own, once at start and then every hour. A pass that is still running when the next is
// due is not run twice.
export function cleanup(jobs: CleanupJob[], { every = CLEANUP_MS, timers = globalThis, warn = console.warn }: CleanupDeps = {}) {
  let running: Promise<void> | null = null;

  async function pass() {
    for (const job of jobs) {
      try {
        await job.run();
      } catch (err) {
        warn(`clean-up ${job.name} failed`, err);
      }
    }
  }

  const runAll = () => (running ??= pass().finally(() => (running = null)));

  return {
    runAll,
    start() {
      void runAll();
      const timer = timers.setInterval(() => void runAll(), every);
      timer.unref?.();
      return () => timers.clearInterval(timer);
    },
  };
}
