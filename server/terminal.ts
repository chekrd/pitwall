import { liveState } from './conversations.ts';
import { pressIn, sendTo, type Driver, type Target } from './delivery.ts';
import * as ghostty from './ghostty.ts';
import * as tmux from './tmux.ts';

// Sessions Pitwall starts run in a detached tmux session, out of sight until shown in a
// Ghostty tab; ones started by hand run in their own Ghostty tab. Either is found by the tty
// of the Claude process.

export async function start(name: string, cwd: string, command: string) {
  if (tmux.TMUX) await tmux.start(name, cwd, command);
  else await ghostty.newTab(cwd, command);
}

export async function stop(name: string) {
  if (tmux.TMUX) await tmux.kill(name);
}

export async function tmuxSessions() {
  return new Set([...(await tmux.panes()).values()].map((p) => p.session));
}

async function driver(tty: string): Promise<Driver> {
  const pane = (await tmux.panes()).get(tty);
  return pane
    ? { paste: (text: string) => tmux.paste(pane, text), keys: (strokes: ghostty.Keystroke[]) => tmux.keys(pane, strokes) }
    : { paste: (text: string) => ghostty.paste(tty, text), keys: (strokes: ghostty.Keystroke[]) => ghostty.keys(tty, strokes) };
}

export const send = async (to: Target, text: string, files: string[] = []) => sendTo(await driver(to.tty), to, liveState, text, files);

export const keys = async (to: Target, strokes: ghostty.Keystroke[]) => pressIn(await driver(to.tty), to, liveState, strokes);

// A tmux session already attached in a Ghostty tab gets that tab; otherwise a new tab attaches.
export async function show(tty: string | null, name: string, cwd: string) {
  const panes = await tmux.panes();
  const session = tty ? panes.get(tty)?.session : [...panes.values()].find((p) => p.session === name)?.session;
  if (!session) {
    if (!tty) throw new Error('this session has no terminal yet');
    return ghostty.focus(tty);
  }
  for (const client of await tmux.clients(session)) {
    try {
      return await ghostty.focus(client);
    } catch {
      // attached from another terminal app
    }
  }
  await ghostty.newTab(cwd, tmux.attachCommand(session));
}
