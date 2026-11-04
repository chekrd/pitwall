import { spawn } from 'node:child_process';
import { loginEnv, which } from './env.ts';

// Missing only where Claude Code is not installed, as in tests; a run then fails when it spawns.
export const CLAUDE = await which('claude').catch(() => 'claude');

export interface HeadlessOptions {
  cwd: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  // Keeps the run's session, which a later run can resume.
  persist?: boolean;
  // Asked for by the developer, or waited on by them: it goes ahead of background runs.
  urgent?: boolean;
  onEvent?: (event: Record<string, any>) => void;
}

const MAX_RUNS = 4;
const GRACE_MS = 5000;

// Every claude -p shares these slots; background runs leave one free, so the developer's never wait behind them.
export function limiter(max: number) {
  let active = 0;
  const queue: { urgent: boolean; go: () => void }[] = [];
  const pump = () => {
    for (let i = 0; i < queue.length;) {
      if (active < (queue[i].urgent ? max : max - 1)) {
        active++;
        queue.splice(i, 1)[0].go();
      } else {
        i++;
      }
    }
  };
  return {
    slot(urgent: boolean, signal?: AbortSignal): Promise<() => void> {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('stopped'));
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          active--;
          pump();
        };
        const onAbort = () => {
          const i = queue.indexOf(entry);
          if (i < 0) return;
          queue.splice(i, 1);
          reject(new Error('stopped'));
        };
        const entry = {
          urgent,
          go: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve(release);
          },
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const firstBackground = urgent ? queue.findIndex((q) => !q.urgent) : -1;
        queue.splice(firstBackground < 0 ? queue.length : firstBackground, 0, entry);
        pump();
      });
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
  };
}

const runs = limiter(MAX_RUNS);

// With onEvent the run streams its messages and the final result is the stream's `result` event.
export async function headless(prompt: string, opts: HeadlessOptions): Promise<Record<string, any>> {
  const release = await runs.slot(!!opts.urgent, opts.signal);
  try {
    return await runCommand(CLAUDE, prompt, opts);
  } finally {
    release();
  }
}

// A group of its own leaves the server's, which launchd ends with the server; so the server ends the groups itself.
const groups = new Set<number>();
const endGroups = () => {
  for (const pid of groups) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
};
process.on('exit', endGroups);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.once(sig, () => {
    endGroups();
    process.kill(process.pid, sig);
  });
}

// Claude runs in a process group of its own, so the shells and servers it started go with it when it is stopped.
export function runCommand(command: string, prompt: string, opts: HeadlessOptions, graceMs = GRACE_MS): Promise<Record<string, any>> {
  const format = opts.onEvent ? ['--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json'];
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('stopped'));
    const child = spawn(command, ['-p', ...format, ...(opts.persist ? [] : ['--no-session-persistence']), ...opts.args], {
      cwd: opts.cwd,
      env: loginEnv,
      detached: true,
    });
    if (child.pid !== undefined) groups.add(child.pid);
    let closed = false;
    let ending = false;
    let timedOut = false;
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // already gone
      }
    };
    const stop = () => {
      if (closed || ending || child.pid === undefined) return;
      ending = true;
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), graceMs).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    opts.signal?.addEventListener('abort', stop, { once: true });
    let out = '';
    let err = '';
    let result: Record<string, any> | null = null;
    let partial = '';
    child.stdout.on('data', (d) => {
      if (!opts.onEvent) return void (out += d);
      const lines = (partial + d).split('\n');
      partial = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') result = event;
          else opts.onEvent(event);
        } catch {
          // not an event line
        }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      closed = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', stop);
      reject(e);
    });
    // What Claude left running, such as a server holding its output open, goes when Claude ends.
    child.on('exit', stop);
    child.on('close', (code, signal) => {
      closed = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', stop);
      groups.delete(child.pid!);
      if (opts.signal?.aborted) return reject(new Error('stopped'));
      if (timedOut) return reject(new Error('claude -p timed out'));
      if (code !== 0) return reject(new Error(signal ? `claude -p was killed by ${signal}` : `claude -p exited ${code}: ${err || out}`.slice(0, 1000)));
      if (opts.onEvent) return result ? resolve(result) : reject(new Error('claude -p ended without a result'));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`claude -p printed invalid JSON: ${out.slice(0, 300)}`));
      }
    });
    // Claude may exit before reading a long prompt; `close` reports that, and EPIPE must not crash the server.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
