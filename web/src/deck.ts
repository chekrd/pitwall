import { decisionKey, menuAnswerText, openDecision } from '../../server/decision.ts';
import { answeredCount, isAnswered, roundAnswerLabel, roundTitle } from '../../server/rounds.ts';
import { compare } from './order.ts';
import type { Body, Request } from './outbox.ts';
import type { Command, Menu, MenuAnswer, RoundAnswers, Session } from './types.ts';
import { attentionOf, decisionOf, menuStuck, type Attention } from './util.ts';

// The queue's cards: the tasks that wait on the developer, in board order, and what each press on the card sends.

export type Kind = 'menu' | 'ask' | 'round' | 'prompt' | 'idle';

const IN_DECK: readonly Attention[] = ['decide', 'focus', 'idle'];

// `busy` are the sessions whose send is held or not yet confirmed: they have been answered on this page.
export function deckOf(sessions: readonly Session[], busy: ReadonlySet<string>, now = Date.now()) {
  return sessions
    .filter((s) => !s.archived && s.status !== 'exited' && !busy.has(s.id) && IN_DECK.includes(attentionOf(s, now)))
    .sort(compare);
}

export function kindOf(s: Session, now = Date.now()): Kind | null {
  const attention = attentionOf(s, now);
  if (attention === 'focus') return 'prompt';
  if (attention === 'idle') return 'idle';
  if (attention !== 'decide') return null;
  const key = decisionKey(s)!;
  return key.startsWith('m:') ? 'menu' : key.startsWith('q:') ? 'ask' : 'round';
}

// The deck as it is read: the front card, then a send that failed until it has been at the front, then the rest in
// board order from the front on, round to the start.
export function rotate<T extends { id: string }>(deck: readonly T[], frontId: string | null, notSent: ReadonlySet<string> = new Set()) {
  const at = Math.max(0, deck.findIndex((s) => s.id === frontId));
  const [front, ...rest] = [...deck.slice(at), ...deck.slice(0, at)];
  return front ? [front, ...rest.filter((s) => notSent.has(s.id)), ...rest.filter((s) => !notSent.has(s.id))] : [];
}

// The card that followed the one leaving in the order the page last showed, passing over cards that left too.
export function successor(lastOrder: readonly string[], leavingId: string, deck: readonly { id: string }[]) {
  const ids = new Set(deck.map((s) => s.id));
  const from = lastOrder.indexOf(leavingId);
  for (let i = 1; i <= lastOrder.length; i++) {
    const id = lastOrder[(from + i) % lastOrder.length];
    if (id !== leavingId && ids.has(id)) return id;
  }
  return deck[0]?.id ?? null;
}

// The card pinned by id stays at the front for as long as it is in the deck; an arrival never takes its place.
export function resolveFront(deck: readonly { id: string }[], pinned: string | null, lastOrder: readonly string[]) {
  if (pinned && deck.some((s) => s.id === pinned)) return pinned;
  return pinned ? successor(lastOrder, pinned, deck) : (deck[0]?.id ?? null);
}

// Decisions that came in after the page loaded and have not been at the front yet, newest first. A new decision on
// the front card itself is an update of the card being read, not an arrival.
export function arrivals(deck: readonly Session[], seen: ReadonlySet<string>, frontId: string | null, now = Date.now()) {
  return deck
    .filter((s) => s.id !== frontId && attentionOf(s, now) === 'decide' && !seen.has(decisionKey(s)!))
    .sort((a, b) => openDecision(b)!.askedAt - openDecision(a)!.askedAt);
}

export const METER_SEGMENTS = 20;

export interface Segment {
  id: string;
  attention: Attention;
  current: boolean;
  arrived: boolean;
}

export interface Bar {
  attention: Attention;
  count: number;
  current: boolean;
  arrived: boolean;
  // Where a click goes: the group's first card, or the next one when the front card is in the group.
  target: string;
}

const GROUPS = [['decide', 'decision', 'decisions'], ['focus', 'terminal prompt', 'terminal prompts'], ['idle', 'finished turn', 'finished turns']] as const;

// One segment per card up to 20, then one bar per attention group with its count. `label` reads
// "3 decisions · 1 terminal prompt · 2 finished turns"; `position` is the front card's place, 1-based, or 0.
export function meter(deck: readonly Session[], frontId: string | null, arrived: ReadonlySet<string> = new Set(), now = Date.now()) {
  const attention = deck.map((s) => attentionOf(s, now));
  const label = GROUPS.flatMap(([a, one, many]) => {
    const n = attention.filter((x) => x === a).length;
    return n ? [`${n} ${n === 1 ? one : many}`] : [];
  }).join(' · ');
  const position = deck.findIndex((s) => s.id === frontId) + 1;
  if (deck.length <= METER_SEGMENTS) {
    const segments: Segment[] = deck.map((s, i) => ({ id: s.id, attention: attention[i], current: s.id === frontId, arrived: arrived.has(s.id) }));
    return { label, position, total: deck.length, segments, bars: null };
  }
  const bars: Bar[] = GROUPS.flatMap(([a]) => {
    const ids = deck.filter((_, i) => attention[i] === a).map((s) => s.id);
    if (!ids.length) return [];
    const at = frontId === null ? -1 : ids.indexOf(frontId);
    return [{ attention: a, count: ids.length, current: at >= 0, arrived: ids.some((id) => arrived.has(id)), target: ids[(at + 1) % ids.length] }];
  });
  return { label, position, total: deck.length, segments: null, bars };
}

export interface Composer {
  open: boolean;
  text: string;
  // Attachments that finished uploading.
  files: readonly string[];
  uploading?: boolean;
}

export type Intent = { intent: 'compose' } | { intent: 'terminal' };

export interface Primary {
  label: string;
  disabled: boolean;
  press: Request | Intent | null;
}

const reply: Primary = { label: 'Reply', disabled: false, press: { intent: 'compose' } };

// An attachment still uploading in the open composer goes along once it is up, so what would send the note sends
// nothing until then.
const uploadingIn = (composer: Composer | undefined) => !!composer?.open && !!composer.uploading;

// The draft and the ready files go along with an option only while the composer is open, so nothing unseen is sent.
function noteOf(composer: Composer | undefined): Body | null {
  if (!composer?.open) return null;
  const text = composer.text.trim();
  if (!text && !composer.files.length) return null;
  const note: Body = {};
  if (text) note.text = text;
  if (composer.files.length) note.files = [...composer.files];
  return note;
}

const noPicks = (menu: Menu) => menu.questions.map(() => ({ labels: [], other: '' }));

// A menu's picks as they start: those made on it before, kept across views and reloads, or none.
export function startPicks(kept: readonly MenuAnswer[] | null, menu: Menu | null): MenuAnswer[] {
  const from = kept ?? (menu ? noPicks(menu) : []);
  return from.map((p) => ({ ...p, labels: [...p.labels] }));
}

// A press on a menu's option: it toggles in a pick-any question, and in a pick-one question it becomes the pick, or
// clears it when it was the pick, along with an own answer.
export function togglePick(picks: readonly MenuAnswer[], question: number, label: string, multi: boolean): MenuAnswer[] {
  return picks.map((p, i) => {
    if (i !== question) return p;
    if (multi) return { ...p, labels: p.labels.includes(label) ? p.labels.filter((l) => l !== label) : [...p.labels, label] };
    return { labels: p.labels[0] === label ? [] : [label], other: '' };
  });
}

export function menuAnswer(s: Session, picks: readonly MenuAnswer[]): Request {
  const answers = picks.map((p) => ({ labels: [...p.labels], other: p.other }));
  return { action: 'answer-menu', body: { toolUseId: s.menu!.toolUseId, answers }, label: menuAnswerText(s.menu!, answers) };
}

function menuPrimary(s: Session, picks: readonly MenuAnswer[]): Primary {
  const questions = s.menu!.questions;
  if (!questions.every((_, i) => picks[i]?.labels.length || picks[i]?.other.trim())) {
    const label = questions.length === 1 ? 'Pick an option' : questions.length === 2 ? 'Answer both questions' : 'Answer every question';
    return { label, disabled: true, press: null };
  }
  return { label: 'Send answer', disabled: false, press: menuAnswer(s, picks) };
}

// The answers given so far to a round's questions, as one send; the questions left out stay open.
export function roundAnswer(s: Session, replies: RoundAnswers): Request {
  const round = s.round!;
  const given = Object.fromEntries(round.questions.flatMap((q) => (isAnswered(replies[q.id]) ? [[q.id, replies[q.id]]] : [])));
  return { action: 'answer-round', body: { round: round.key, replies: given }, label: roundAnswerLabel(round, given) };
}

function roundPrimary(s: Session, replies: RoundAnswers): Primary {
  const all = s.round!.questions.length;
  const n = answeredCount(s.round!, replies);
  if (!n) return { label: all === 1 ? 'Answer the question' : 'Answer a question', disabled: true, press: null };
  const label = all === 1 ? 'Send answer' : n === all ? `Send all ${all} answers` : `Send ${n} of ${all} answers`;
  return { label, disabled: false, press: roundAnswer(s, replies) };
}

// The footer's primary button, which ⏎ presses: the option Claude recommends (with the open composer's note), the
// picks of a menu, the answers to a round, Terminal, or Reply. It never sends the composer's text by itself; Enter in
// the composer does that.
export function primary(
  s: Session, input: { composer?: Composer; picks?: readonly MenuAnswer[] | undefined; replies?: RoundAnswers | undefined } = {}, now = Date.now(),
): Primary {
  const kind = kindOf(s, now);
  if (kind === 'prompt') return { label: 'Terminal', disabled: false, press: { intent: 'terminal' } };
  if (kind === 'round') return roundPrimary(s, input.replies ?? {});
  if (kind === 'menu') return menuPrimary(s, input.picks ?? noPicks(s.menu!));
  if (kind !== 'ask') return { ...reply, disabled: kind !== 'idle' };
  const d = decisionOf(s)!;
  const recommended = d.options.find((o) => o.recommended);
  if (!recommended) return d.options.length ? { label: 'Pick an option', disabled: true, press: null } : reply;
  const note = noteOf(input.composer);
  return {
    label: note ? `Send “${recommended.label}” + your note` : `Send “${recommended.label}”`,
    disabled: uploadingIn(input.composer),
    press: { action: 'answer', body: { key: d.key, choice: recommended.label, ...note }, label: recommended.label },
  };
}

// What ⏎ would send without the note. The key guard restarts when this changes under the reader.
export function targetOf(s: Session, now = Date.now()) {
  const { press } = primary(s, {}, now);
  if (!press) return 'none';
  if ('intent' in press) return press.intent;
  return press.action === 'answer' ? `choice:${press.body.choice}` : press.action;
}

// An option pressed on an ask card, with the open composer's note. Null while an attachment is still uploading.
export function choose(s: Session, label: string, composer?: Composer): Request | null {
  if (uploadingIn(composer)) return null;
  return { action: 'answer', body: { key: decisionKey(s)!, choice: label, ...noteOf(composer) }, label };
}

// As the server tells a command from an answer: a `!` line, or a `/name` from its command list. Until that list has
// loaded nothing counts, so no answer is mistaken for a command that keeps its card and skips the early check.
export function isCommand(text: string, files: number, commands: readonly Command[] | null) {
  if (files || !commands) return false;
  if (text.startsWith('!')) return true;
  const name = text.match(/^\/(\S+)/)?.[1];
  return !!name && commands.some((c) => c.name === name);
}

// What Enter in a composer sends: an answer to the card's decision (`key`), or a plain message (null).
export function typed(key: string | null, text: string, files: readonly string[], commands: readonly Command[] | null): Request {
  const t = text.trim();
  if (isCommand(t, files.length, commands)) return { action: 'answer', body: { key, text: t }, label: t, command: true };
  const body: Body = { key };
  if (t) body.text = t;
  if (files.length) body.files = [...files];
  return { action: 'answer', body, label: t || (files.length === 1 ? '1 file' : `${files.length} files`) };
}

export function declining(s: Session): Request {
  const menu = s.menu!;
  return { action: 'decline-menu', body: { toolUseId: menu.toolUseId }, label: menu.questions.map((q) => q.question).join(' · ') };
}

export function dismissal(s: Session): Request {
  const key = decisionKey(s)!;
  return { action: 'dismiss', body: { key }, label: key.startsWith('r:') ? roundTitle(s.round!) : decisionOf(s)!.problem };
}

// The Needs-focus card: what the terminal shows, and its subject when Claude names one ("… for Bash: pnpm test").
export function promptOf(s: Session, now = Date.now()) {
  if (menuStuck(s, now)) return { headline: 'Claude still shows its menu in the terminal', subject: null };
  const waiting = s.waitingFor ?? 'a prompt';
  const at = waiting.indexOf(' for ');
  return { headline: `Claude is showing ${waiting} in its terminal`, subject: at > 0 ? waiting.slice(at + 5) : null };
}
