import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from './config.ts';
import { loginEnv, quote, which } from './env.ts';
import type { Keystroke } from './ghostty.ts';
import * as input from './tmuxInput.ts';

const exec = promisify(execFile);

export const TMUX = await which('tmux').catch(() => '');
// An own socket and config, so the user's tmux and ~/.tmux.conf never mix in.
const SOCKET = 'pitwall';
// Sessions started before the rename to Pitwall run on the old socket until they end.
const OLD_SOCKET = 'agent-board';
const argsOf = (socket: string) => ['-u', '-L', socket, '-f', join(ROOT, 'config', 'tmux.conf')];
// Filled from the latest list of panes, so a session that ended leaves it then.
let socketOf = new Map<string, string>();
const on = (name: string) => socketOf.get(name) ?? SOCKET;

async function run(socket: string, args: string[], stdin?: string) {
  const running = exec(TMUX, [...argsOf(socket), ...args], { env: loginEnv });
  // A tmux that fails before it reads its input closes the pipe; its exit says why.
  running.child.stdin?.on('error', () => {});
  if (stdin !== undefined) running.child.stdin?.end(stdin);
  return (await running).stdout;
}

// The tmux server keeps the environment of whoever started it, which may predate a locale fix.
const localeArgs = ['LANG', 'LC_ALL', 'LC_CTYPE'].flatMap((k) => (loginEnv[k] ? ['-e', `${k}=${loginEnv[k]}`] : []));

export async function start(name: string, cwd: string, command: string) {
  await run(SOCKET, ['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...localeArgs, command]);
}

export async function kill(name: string) {
  for (const socket of [OLD_SOCKET, SOCKET]) await run(socket, ['kill-session', '-t', `=${name}`]).catch(() => {});
  socketOf.delete(name);
}

// One pane of a tmux session; `id` (`%N`) names it alone, wherever the session's active pane is.
export interface Pane {
  session: string;
  id: string;
  socket: string;
}

// tty → its pane, for every pane on Pitwall's sockets.
export async function panes() {
  const byTty = new Map<string, Pane>();
  if (!TMUX) return byTty;
  const sockets = new Map<string, string>();
  for (const socket of [OLD_SOCKET, SOCKET]) {
    let out = '';
    try {
      out = await run(socket, ['list-panes', '-a', '-F', '#{pane_tty}\t#{session_name}\t#{pane_id}']);
    } catch (err) {
      if (/no server running|error connecting/.test(String((err as { stderr?: string }).stderr))) continue;
      throw err;
    }
    for (const line of out.split('\n').filter(Boolean)) {
      const [tty, session, id] = line.split('\t');
      byTty.set(tty, { session, id, socket });
      sockets.set(session, socket);
    }
  }
  socketOf = sockets;
  return byTty;
}

export async function clients(name: string) {
  return (await run(on(name), ['list-clients', '-t', `=${name}`, '-F', '#{client_tty}'])).split('\n').filter(Boolean);
}

const tmux = (pane: Pane) => (args: string[], stdin?: string) => run(pane.socket, args, stdin);

export const paste = (pane: Pane, text: string) => input.paste(tmux(pane), pane.id, text);

export const keys = (pane: Pane, strokes: Keystroke[]) => input.keys(tmux(pane), pane.id, strokes);

// `exec`, so the tab closes when the session ends; closing the tab only detaches.
export const attachCommand = (name: string) => `exec ${[TMUX, ...argsOf(on(name)), 'attach-session', '-t', `=${name}`].map(quote).join(' ')}`;
