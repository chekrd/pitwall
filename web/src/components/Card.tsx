import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { choose, declining, dismissal, kindOf, menuAnswer, primary as primaryOf, type Composer as Note, type Intent } from '../deck.ts';
import type { Action, Card as Keys } from '../keys.ts';
import type { Request } from '../outbox.ts';
import { roundTitle } from '../../../server/rounds.ts';
import { queue, useQueue } from '../queue.ts';
import { useRoundAnswers } from '../rounds.ts';
import { openSheet, sessionPath } from '../router.ts';
import { hold } from '../sends.ts';
import type { RepoView, Session } from '../types.ts';
import { useDecision, useKeyed } from '../useDecision.ts';
import { useFront } from '../useKeys.ts';
import { attentionOf, decisionOf, locate, sessionLabel } from '../util.ts';
import { track } from '../ux.ts';
import styles from './Card.module.css';
import { Composer, readyPaths, uploading, useDraft } from './Composer.tsx';
import { DecisionBody } from './DecisionBody.tsx';
import { Icon } from './Icon.tsx';
import { LatestReply } from './LatestReply.tsx';
import { MenuBody } from './MenuBody.tsx';
import { Age, BranchMark, Headline } from './Parts.tsx';
import { PromptBody } from './PromptBody.tsx';
import { RoundBody } from './RoundBody.tsx';
import { archive, ClearButton, openTerminal, SessionMenu } from './SessionMenu.tsx';
import { StateMark } from './StateMark.tsx';
import { labelOf, stoppedOnError } from './Status.tsx';
import { TaskRail } from './TaskRail.tsx';
import { TurnBody } from './TurnBody.tsx';
import { explain, TIPS } from './explain.ts';

// The guard as the card draws it, redrawn when it ends.
function useGuarded(until: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const left = until - Date.now();
    if (left <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), left + 1);
    return () => clearTimeout(timer);
  }, [until]);
  return now < until;
}

export interface CardProps {
  session: Session;
  repos: RepoView[];
  // How many cards wait, for the footer's own Previous and Skip in a narrow window.
  deck: number;
  // Drawn after the reader saw another card, so it comes in rather than being there at once.
  enter: boolean;
}

const NOTE_MS = 5000;

const metaChip = (text: string, title?: string) => <span className={styles.chip} data-explain={title}>{text}</span>;

export function Card({ session, repos, deck, enter }: CardProps) {
  const q = useQueue();
  const article = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const { worktree, branch } = locate(repos, session);
  const name = sessionLabel(session, branch);
  const kind = kindOf(session) ?? 'idle';
  const attention = attentionOf(session);
  const decision = kind === 'ask' ? decisionOf(session) : null;
  const menu = kind === 'menu' ? session.menu : null;
  // The compiler reads what a callback uses during render, so a `decision!.options` there would throw on other cards.
  const options = decision?.options ?? [];
  const round = kind === 'round' ? session.round : null;
  // What a reply can be written to instead: a question or a round.
  const asks = decision !== null || round !== null;
  const { key, picks, setPicks, toggle, answerOwn, questions, lone } = useDecision(session, menu);
  const [replies, setReplies] = useRoundAnswers(round ? key : null);
  const draft = useDraft(session.id);
  const filled = !!draft.text || draft.files.length > 0;
  const guarded = useGuarded(q.guardUntil);
  const notSent = q.notSent.get(session.id);

  const [composing, setComposing] = useState(() => decision?.options.length === 0 || filled);
  const [focusAsk, setFocusAsk] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [hidden, setHidden] = useKeyed(key, () => false);

  // A draft that comes back, from a send taken back or refused, shows in the reply box.
  useEffect(() => {
    if (filled && asks) setComposing(true);
  }, [filled]);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  useEffect(() => {
    track('card-shown', { task: session.id, decision: key ?? undefined, kind, deck });
  }, [session.id, key]);

  // An outside change brings the card in; a deal runs its own transition.
  useLayoutEffect(() => {
    if (enter && !document.documentElement.dataset.deal) article.current!.dataset.enter = '';
  }, []);

  // The card stays when its session moves on to another decision, which starts at its top.
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [kind, key]);

  const open = kind === 'idle' || (asks && composing);
  const box: Note = { open: asks && composing, text: draft.text, files: readyPaths(draft), uploading: uploading(draft) };
  const primary = primaryOf(session, { composer: box, picks: menu ? picks : undefined, replies: round ? replies : undefined });

  const focusCard = () => article.current?.focus({ preventScroll: true });
  const compose = () => {
    setComposing(true);
    setFocusAsk((n) => n + 1);
  };
  const closeComposer = () => {
    setComposing(false);
    focusCard();
  };
  // A press holds its request for 5 s, and the card leaves with it: sideways for a dismissal, down otherwise. Focus
  // in a field the card takes along would be left on the page, so the card takes it first. A command answers
  // nothing, so its card stays.
  const send = (r: Request) => {
    if (r.command) {
      hold(session, r, name);
      if (asks) setNote(`${r.label.split(/\s/)[0]} goes to the terminal as typed; the question stays open.`);
      return;
    }
    if (article.current?.contains(document.activeElement)) focusCard();
    queue.deal(r.action === 'dismiss' || r.action === 'decline-menu' ? 'side' : 'down', () => void hold(session, r, name, { dealt: true }));
  };
  const press = (p: Request | Intent | null) => {
    if (!p) return;
    if (!('intent' in p)) send(p);
    else if (p.intent === 'terminal') openTerminal(session.id).catch(reportError);
    else compose();
  };
  const pressPrimary = () => {
    if (!primary.disabled && !queue.guarded()) press(primary.press);
  };
  const pick = (label: string) => {
    if (queue.guarded()) return;
    const r = choose(session, label, box);
    if (r) send(r);
    else setNote('An attachment is still uploading; nothing was sent.');
  };
  const pickInMenu = (question: number, label: string) => {
    if (!lone) return toggle(question, label);
    if (queue.guarded()) return;
    const only = [{ labels: [label], other: '' }];
    setPicks(only);
    send(menuAnswer(session, only));
  };
  const dismiss = () => {
    if (!queue.guarded()) send(dismissal(session));
  };
  const decline = () => {
    if (!queue.guarded()) send(declining(session));
  };
  const archiveIt = () => {
    if (!queue.guarded()) archive(session, name);
  };

  const keys: Keys = {
    kind,
    options: options.length,
    questions: questions.map((x) => x.options.length),
    lone,
    primary: !primary.disabled && primary.press !== null,
    composing: asks && composing,
  };
  const act = (a: Action) => {
    if (a.type === 'option') pick(options[a.index].label);
    else if (a.type === 'pick') pickInMenu(a.question, questions[a.question].options[a.option].label);
    else if (a.type === 'primary') pressPrimary();
    else if (a.type === 'skip') queue.skip();
    else if (a.type === 'previous') queue.previous();
    else if (a.type === 'details') setHidden(!hidden);
    else if (a.type === 'compose') compose();
    else if (a.type === 'open') openSheet(session.id, a.tab);
    else if (a.type === 'archive') archiveIt();
    else if (a.type === 'close') closeComposer();
  };
  useFront({ card: keys, act });

  let meta: ReactNode;
  if (kind === 'ask') {
    meta = <><Age at={session.question?.askedAt ?? session.updatedAt} prefix="asked " />{metaChip(session.question?.category ?? '', 'The kind of question, as Claude classified it')}</>;
  } else if (menu) {
    meta = <><Age at={menu.at} prefix="asked " />{metaChip('asked in the terminal', 'Claude opened a choice menu in its terminal; answering here picks the options there for you')}</>;
  } else if (round) {
    const n = round.questions.length;
    meta = <><Age at={round.at} prefix="asked " />{metaChip(n === 1 ? '1 question' : `${n} questions`, 'Claude asked these at once; answer each on its own and send them together')}</>;
  } else if (kind === 'prompt') {
    meta = <><Age at={session.updatedAt} />{session.tty && <code className={styles.tty} data-explain="The terminal device Claude runs on">{session.tty}</code>}</>;
  } else meta = <Age at={session.updatedAt} prefix="finished " />;

  const composer = {
    focus: focusAsk,
    note,
    onSend: send,
    onEscape: () => (asks ? closeComposer() : focusCard()),
  };

  return (
    <article
      ref={article}
      className={styles.card}
      data-card
      data-session={session.id}
      data-kind={kind}
      data-key={key ?? undefined}
      aria-label={`${name} · ${labelOf(session, attention)}`}
      tabIndex={-1}
    >
      <header className={styles.head}>
        <div className={styles.top}>
          <span className={styles.state} data-attention={attention} data-error={stoppedOnError(session, attention) || undefined}>
            <StateMark state={attention} />
            {labelOf(session, attention)}
          </span>
          {q.updated.has(session.id) && <span className={styles.updated} data-updated>Updated just now</span>}
          <BranchMark session={session} branch={branch} />
          <a className={styles.name} href={sessionPath(session.id)} data-explain="Open the task on its own page" data-open-task data-ux="task">{name}</a>
          <span className={styles.spacer} />
          <nav className={styles.nav} aria-label="Open the task">
            <button type="button" onClick={() => openSheet(session.id, 'overview')}>Overview <kbd>O</kbd></button>
            <button type="button" onClick={() => openSheet(session.id, 'diff')}>Diff <kbd>D</kbd></button>
            {session.artifacts.length > 0 && (
              <button type="button" onClick={() => openSheet(session.id, 'artifacts')}>Artifacts {session.artifacts.length}</button>
            )}
            {session.parked.length > 0 && (
              <button type="button" data-later-count data-explain="Messages you kept for later, on its Overview" onClick={() => openSheet(session.id, 'overview')}>
                Later {session.parked.length}
              </button>
            )}
            <span className={styles.more}><ClearButton session={session} /><SessionMenu session={session} worktree={worktree} name={name} /></span>
          </nav>
        </div>
        <div className={styles.meta}>{meta}</div>
      </header>
      <div ref={scroll} className={styles.scroll} data-scroll>
        <div className={styles.layout}>
          <div className={styles.main}>
            {notSent?.shown && <p className={styles.notSent} data-not-sent role="alert">Not sent: {notSent.message}</p>}
            {decision && (
              <DecisionBody
                session={session}
                decision={decision}
                hidden={hidden}
                onDetails={() => setHidden(!hidden)}
                onPick={pick}
                composer={open ? composer : null}
              />
            )}
            {menu && (
              <MenuBody menu={menu} picks={picks} onPick={pickInMenu} onOther={answerOwn} onSubmit={pressPrimary} />
            )}
            {round && (
              <div className={styles.round}>
                <Headline text={roundTitle(round)} />
                <RoundBody session={session} round={round} answers={replies} onAnswers={setReplies} />
                {open && (
                  <Composer session={session} decision={key} label="A message instead of answers" placeholder="Write to Claude instead of answering; the questions close with it…" {...composer} />
                )}
              </div>
            )}
            {kind === 'prompt' && <PromptBody session={session} />}
            {kind === 'idle' && <TurnBody session={session} />}
            {(kind === 'ask' || menu || round) && session.lastMessage && (
              <div className={styles.reply} data-reply><LatestReply key={session.lastMessage} text={session.lastMessage} /></div>
            )}
          </div>
          <TaskRail session={session} />
        </div>
      </div>
      <footer className={styles.foot} data-kind={kind} data-guarding={guarded || undefined}>
        {kind !== 'idle' && <button
          type="button"
          className={styles.primary}
          data-primary
          data-guarded={guarded || undefined}
          disabled={primary.disabled}
          {...(round ? explain(TIPS.sendRound) : { 'data-explain': menu ? "Picks your answers in Claude's terminal menu" : undefined })}
          onClick={pressPrimary}
        >
          <span className={styles.primaryLabel}>{primary.label}</span>
          <kbd>↵</kbd>
        </button>}
        <span className={styles.steps}>
          <button type="button" aria-label="Previous card" disabled={deck < 2} onClick={() => queue.previous()}><Icon name="arrow-left" size={18} /></button>
          <button type="button" aria-label="Skip to the next card" disabled={deck < 2} onClick={() => queue.skip()}><Icon name="arrow-right" size={18} /></button>
        </span>
        {kind === 'idle' && (
          <div className={styles.message}>
            <Composer session={session} decision={null} label="Message Claude" placeholder="Reply, / for commands, paste or drop files…" inline {...composer} />
          </div>
        )}
        <div className={styles.actions}>
          {asks && (
            <button
              type="button"
              className={styles.secondary}
              aria-pressed={composing}
              data-explain={round ? 'Write Claude a message of your own instead of answering the questions; they close with it' : undefined}
              onClick={() => (composing ? closeComposer() : compose())}
            >
              {round ? 'Write instead' : 'Write my own'} <kbd>W</kbd>
            </button>
          )}
          {kind === 'idle' && (
            <button type="button" className={styles.secondary} onClick={archiveIt}>Archive <kbd>X</kbd></button>
          )}
          {(kind === 'ask' || round) && (
            <button type="button" className={styles.dismiss} data-explain={round ? 'Clear the questions without answering them' : 'Clear the question without answering it'} onClick={dismiss}>Dismiss</button>
          )}
          {kind === 'menu' && session.menu && <button type="button" className={styles.dismiss} {...explain(TIPS.decline)} onClick={decline}>Decline</button>}
        </div>
      </footer>
    </article>
  );
}
