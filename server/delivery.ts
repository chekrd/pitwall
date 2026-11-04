import { sameStart, type LiveState } from './conversations.ts';
import { Refusal } from './decision.ts';
import { PartlyTyped, type Keystroke } from './ghostty.ts';

// The Claude a send is meant for, as the latest sync saw it. `prompt` when the send answers what Claude shows in its
// terminal, a menu, rather than typing at its prompt.
export interface Target {
  pid: number;
  tty: string;
  conversation: string;
  prompt?: boolean;
}

export interface Driver {
  paste: (text: string) => Promise<void>;
  keys: (strokes: Keystroke[]) => Promise<void>;
}

export type Read = (pid: number) => Promise<LiveState>;

// Text that went into the terminal without the Enter that would send it.
export class Unsent extends PartlyTyped {}

// Why typing into `t` now would not reach that Claude's prompt, or null when it would. Its pid may be another process
// by now, its conversation another after a /clear or /resume, its terminal may show an editor or a shell it gave way
// to, or Claude a permission prompt that the keys would answer.
export function hindrance(t: Target, { file, ps }: LiveState): string | null {
  if (!file || !ps || !sameStart(file.procStart, ps.start)) return 'Claude has quit';
  if (file.sessionId !== t.conversation) return 'Claude has moved on to another conversation';
  if (ps.tty !== t.tty) return 'Claude runs in another terminal now';
  if (ps.pgid !== ps.tpgid) return 'another program is in the front of its terminal';
  if (!t.prompt && file.status === 'waiting') return `Claude is showing ${typeof file.waitingFor === 'string' ? file.waitingFor : 'a prompt'} in its terminal`;
  return null;
}

// Once text went in, no more keys go to a terminal that failed the check, since they would reach whatever is there
// now: the text stays typed and unsent, for you to see there.
async function verify(t: Target, read: Read, typed: boolean) {
  const why = hindrance(t, await read(t.pid));
  if (!why) return;
  if (typed) throw new Unsent(`${why}, so Enter was not pressed: the text is typed in its terminal but not sent; send or clear it there`);
  throw new Refusal(`${why}; nothing was typed`, 'stale');
}

const CONTROL = /[^\P{Cc}\n\t]/gu;

// A paste of text arrives as one prompt even with several lines; Enter goes separately once the TUI has taken it in.
// Control characters are dropped so the text cannot end the paste and type keys itself. Claude Code turns a paste of
// nothing but image paths into image attachments, so images go in a paste of their own first; other files stay paths
// in the text for Claude to read. The target is checked right before each paste and before the Enter.
export async function sendTo(d: Driver, to: Target, read: Read, text: string, files: string[] = [], ms = 200) {
  const pause = () => new Promise((r) => setTimeout(r, ms));
  let typed = false;
  const paste = async (t: string) => {
    await verify(to, read, typed);
    await d.paste(t);
    typed = true;
  };
  const images = files.filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
  if (images.length) {
    await paste(images.join(' '));
    await pause();
  }
  const clean = [...files.filter((f) => !images.includes(f)), text.replaceAll('\r\n', '\n').replace(CONTROL, '')].filter(Boolean).join(' ');
  if (clean) await paste(images.length ? ` ${clean}` : clean);
  await pause();
  await verify(to, read, typed);
  await d.keys([{ key: 'enter' }]);
}

export async function pressIn(d: Driver, to: Target, read: Read, strokes: Keystroke[]) {
  await verify(to, read, false);
  await d.keys(strokes.map((k) => ('key' in k ? k : { text: k.text.replace(CONTROL, '') })));
}
