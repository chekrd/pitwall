import { useEffect, useRef, useState, type FocusEvent, type RefObject } from 'react';
import { sessionAction } from '../api.ts';
import { choose, declining, dismissal, kindOf, menuAnswer, primary as primaryOf, typed, type Composer as Note } from '../answers.ts';
import { openDecision } from '../../../server/decision.ts';
import type { Request } from '../outbox.ts';
import { nextDecision, waitingOf } from '../order.ts';
import { roundTitle } from '../../../server/rounds.ts';
import { useRoundAnswers } from '../rounds.ts';
import { closeSheet, closeSheetOf, showTab } from '../router.ts';
import { hold, useBusy, useNotSent } from '../sends.ts';
import { useStore } from '../store.ts';
import type { Link, RepoView, Session } from '../types.ts';
import { guarded, signature, useDecision, useGuard, useKeyed } from '../useDecision.ts';
import { isEditable, useFront, type Front } from '../useKeys.ts';
import { track } from '../ux.ts';
import { ago, attentionOf, contextUse, decisionOf, effortName, folderTaskOf, isDelivered, menuStuck, modelName, shortUrl, tilde, worktreeName } from '../util.ts';
import { Clock } from './Clock.tsx';
import { useCopy } from './CopyButton.tsx';
import { Composer, readyPaths, uploading, useDraft } from './Composer.tsx';
import { DecisionBody } from './DecisionBody.tsx';
import { Icon } from './Icon.tsx';
import { Later, LaterActions } from './Later.tsx';
import { PhaseStrip } from './Workflow.tsx';
import { LatestReply } from './LatestReply.tsx';
import { useSending, waitingText, YourMessage } from './YourMessage.tsx';
import { MenuBody } from './MenuBody.tsx';
import { Age } from './Parts.tsx';
import { interruptedAs, resumePaused } from './RestartBanner.tsx';
import { RoundBody } from './RoundBody.tsx';
import styles from './Overview.module.css';
import { scheduledNote } from '../schedules.ts';
import { editFailedTask } from './NewTaskForm.tsx';
import { failedToStart, STATE_LABELS, stoppedOnError } from './Status.tsx';
import { askDeleteWorktree } from './DeleteWorktreeDialog.tsx';
import { FocusButton } from './SessionMenu.tsx';
import { NextDecision } from './TopBar.tsx';
import { explain, SENDS, TIPS } from './explain.ts';

function Copy({ value, what, title, shown = value }: { value: string; what: string; title?: string; shown?: string }) {
  const { copied, copy } = useCopy(value, what);
  return (
    <button type="button" className={styles.copy} data-ux={`copy ${what.toLowerCase()}`} data-copied={copied || undefined} data-explain={title} aria-label={`Copy ${what.toLowerCase()} ${value}`} onClick={copy}>
      <code>{shown}</code>
      <span className={styles.copyMark} aria-live="polite">
        <Icon name={copied ? 'check' : 'copy'} size={13} />
        {copied && 'Copied'}
      </span>
    </button>
  );
}

function LinkList({ links }: { links: Link[] }) {
  return (
    <ul className={styles.links}>
      {links.map((l) => (
        <li key={l.url}>
          <a href={l.url} target="_blank" rel="noreferrer" data-explain={l.context || l.url} data-ux="link">
            <strong>{l.about || l.text || shortUrl(l.url)}</strong>
            <span>{l.about || l.text ? `${shortUrl(l.url)} · ` : ''}{ago(l.at)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

// Another task or another decision on it: what must not replace a field the reader is typing in.
const differs = (a: Session | null, b: Session | null) => a?.id !== b?.id || (!!a && !!b && signature(a) !== signature(b));

// The decision as the page shows it. While the reader types in its reply box, a new decision, or none, waits until
// focus leaves the box, so the box stays the field they write in and Enter answers what they read.
function useShown(live: Session | null) {
  const [typing, setTyping] = useState(false);
  const [shown, setShown] = useState(live);
  const next = typing && differs(shown, live) ? shown : live;
  if (next !== shown) setShown(next);
  const onFocus = (e: FocusEvent) => setTyping(isEditable(e.target));
  const onBlur = (e: FocusEvent) => {
    const to = e.relatedTarget;
    // Focus went to the page, or the window lost it and the field gets it back with the window.
    if (!to) {
      if (document.hasFocus()) setTyping(false);
      return;
    }
    setTyping(e.currentTarget.contains(to) && isEditable(to));
  };
  return { shown: next, onFocus, onBlur };
}

const KIND_LABEL = { ask: 'Decision', menu: 'Asked in the terminal', round: 'Questions' } as const;

const UPLOADING = 'An attachment is still uploading; nothing was sent.';

// A decision answered on its task page: Claude's question with its details and options, a menu, or a round, with a
// reply box. ⏎ presses the main button. A send is held with its Undo, and the reply box goes with it. `box` is off
// while Message Claude stays for the writing in it.
function OpenDecision({ session, name, box: ownBox, onSent }: { session: Session; name: string; box: boolean; onSent: () => void }) {
  const kind = kindOf(session) as 'ask' | 'menu' | 'round';
  const menu = kind === 'menu' ? session.menu : null;
  const decision = kind === 'ask' ? decisionOf(session) : null;
  const round = kind === 'round' ? session.round : null;
  const { key, picks, setPicks, toggle, answerOwn, lone } = useDecision(session, menu);
  const [replies, setReplies] = useRoundAnswers(round ? key : null);
  const [hidden, setHidden] = useKeyed(key, () => false);
  const draft = useDraft(session.id);
  const [note, setNote] = useState<string | null>(null);
  const [focusAsk, setFocusAsk] = useState(0);
  const guarding = useGuard(signature(session));
  const notSent = useNotSent(session);
  const box: Note = { open: true, text: draft.text, files: readyPaths(draft), uploading: uploading(draft) };
  const primary = primaryOf(session, { composer: box, picks: menu ? picks : undefined, replies: round ? replies : undefined });

  useEffect(() => {
    track('decision-shown', { task: session.id, decision: key ?? undefined, kind });
  }, [session.id, key]);

  const send = (r: Request | null) => {
    if (!r) return setNote(UPLOADING);
    setNote(r.command ? `${r.label.split(/\s/)[0]} goes to the terminal as typed; the question stays open.` : null);
    void hold(session, r, name);
    if (!r.command) onSent();
  };
  const answer = (r: Request | null) => {
    if (!guarded()) send(r);
  };
  const compose = () => setFocusAsk((n) => n + 1);
  const pressPrimary = () => {
    const p = primary.press;
    if (primary.disabled || !p || guarded()) return;
    if (!('intent' in p)) send(p);
    else if (p.intent === 'compose') compose();
  };
  const pickInMenu = (question: number, label: string) => {
    if (!lone) return toggle(question, label);
    if (guarded()) return;
    const only = [{ labels: [label], other: '' }];
    setPicks(only);
    send(menuAnswer(session, only));
  };

  const keys: Front = {
    decision: { kind, details: !!decision?.context, primary: !primary.disabled && primary.press !== null, reply: ownBox && kind !== 'menu' },
    act: (a) => {
      if (a.type === 'primary') pressPrimary();
      else if (a.type === 'details') setHidden(!hidden);
      else if (a.type === 'compose') compose();
    },
  };
  useFront(keys);

  const composer = { focus: focusAsk, note, onSend: answer, onEscape: closeSheet };
  const asked = openDecision(session)?.askedAt ?? session.updatedAt;
  return (
    <section className={styles.decision} data-decision data-session={session.id} data-kind={kind} data-key={key ?? undefined} data-guarding={guarding || undefined} data-ux-section="decision">
      <span className={styles.kicker}>
        {KIND_LABEL[kind]}
        <span className={styles.asked}>
          {kind === 'ask' && session.question?.category && <> · {session.question.category}</>}
          <Age at={asked} prefix=" · asked " />
        </span>
      </span>
      {notSent && <p className={styles.notSent} data-not-sent role="alert">Not sent: {notSent}</p>}
      {decision && (
        <DecisionBody
          session={session}
          decision={decision}
          hidden={hidden}
          onDetails={() => setHidden(!hidden)}
          onPick={(label) => answer(choose(session, label, box))}
          composer={ownBox ? composer : null}
        />
      )}
      {round && (
        <>
          <h3>{roundTitle(round)}</h3>
          <RoundBody session={session} round={round} answers={replies} onAnswers={setReplies} />
          {ownBox && <Composer
            session={session}
            decision={key}
            label="A message instead of answers"
            placeholder="Write to Claude instead of answering; the questions close with it…"
            {...composer}
          />}
        </>
      )}
      {menu && <MenuBody menu={menu} picks={picks} onPick={pickInMenu} onOther={answerOwn} onSubmit={pressPrimary} />}
      <div className={styles.decisionActions}>
        {!lone && (
          <button
            type="button"
            className={styles.primary}
            data-primary
            data-guarded={guarding || undefined}
            disabled={primary.disabled}
            {...(round ? explain(TIPS.sendRound) : { 'data-explain': menu ? "Picks your answers in Claude's terminal menu" : undefined })}
            onClick={pressPrimary}
          >
            <span className={styles.primaryLabel}>{primary.label}</span>
            <kbd>↵</kbd>
          </button>
        )}
        {kind !== 'menu' && (
          <button type="button" data-explain={round ? 'Clear the questions without answering them' : 'Clear the question without answering it'} onClick={() => answer(dismissal(session))}>Dismiss</button>
        )}
        {menu && <button type="button" {...explain(TIPS.decline)} onClick={() => answer(declining(session))}>Decline</button>}
      </div>
    </section>
  );
}

// After a decision answered here, the way on to the next task that waits for one.
function NextAfter({ session }: { session: Session }) {
  const { sessions } = useStore();
  const next = nextDecision(waitingOf(sessions, useBusy()), session.id);
  if (!next.next) return null;
  return (
    <section className={styles.after} data-next-after data-ux-section="next decision">
      <p>{next.count === 1 ? 'One more task waits for a decision.' : `${next.count} more tasks wait for a decision.`}</p>
      <NextDecision next={next} className={styles.nextButton} />
    </section>
  );
}

const CONTINUE_TURN = 'The Mac restarted while you were working and cut your last turn short. Check where you got to, then carry on.';

function Paused({ session }: { session: Session }) {
  if (session.status === 'working') return null;
  return (
    <section className={styles.blocked} data-interrupted="paused" data-ux-section="paused">
      <p>
        You paused this task mid-turn{session.status === 'exited' && ', and its Claude has ended since'}.
        {' '}<strong>Resume</strong> has it start its background tasks again, check where it got to and carry on.
      </p>
      <button type="button" data-variant="primary" {...explain(SENDS.resume)} onClick={() => void resumePaused(session.id).catch(reportError)}>Resume</button>
    </section>
  );
}

function Interrupted({ session, name }: { session: Session; name: string }) {
  if (session.interrupted!.cause === 'pause') return <Paused session={session} />;
  const was = STATE_LABELS[interruptedAs(session)].toLowerCase();
  const { waitingFor, menu } = session.interrupted!;
  const asked = waitingFor ?? (menu && `its question “${menu.questions.map((q) => q.question).join(' · ')}”`);
  if (session.status === 'exited') {
    return (
      <section className={styles.blocked} data-interrupted="ended" data-ux-section="interrupted">
        <p>The Mac restarted while this task was <strong>{was}</strong>{asked && <> ({asked})</>}, and its Claude ended with it.</p>
        <button type="button" data-variant="primary" onClick={() => void sessionAction(session.id, 'focus').catch(reportError)}>Continue</button>
      </section>
    );
  }
  if (session.status === 'working') return null;
  return (
    <section className={styles.blocked} data-interrupted="cut-short" data-ux-section="interrupted">
      <p>The restart cut Claude's turn short{asked && <>, at {asked}</>}. It waits for you: <strong>Continue the turn</strong> asks it to check where it got to and carry on.</p>
      <button type="button" data-variant="primary" {...explain(SENDS.prompt(CONTINUE_TURN))} onClick={() => void hold(session, typed(null, CONTINUE_TURN, [], null), name)}>Continue the turn</button>
    </section>
  );
}

const ERROR_ADVICE = {
  refusal: <>The model's safeguards flagged your last message, so Claude wrote no reply. Sent again as it is, it will likely be flagged again: <strong>rephrase it</strong> below, or in its terminal press Esc twice to edit it or pick another model with /model.</>,
  limit: <>You hit your usage limit, so Claude wrote no reply. <strong>Try again</strong> once the limit resets.</>,
  model: <>This model is out of usage, so Claude wrote no reply; other models still run. <strong>Continue on</strong> another model switches it with /model and has Claude answer your last message again.</>,
  login: <>Claude's login expired, so it wrote no reply. Run <strong>/login</strong> in its terminal, then <strong>Try again</strong>.</>,
  other: <>The request failed, so Claude wrote no reply. <strong>Try again</strong> has it answer your last message.</>,
};

const RETRY_TURN = 'Your last turn stopped on an API error before you replied. Answer my last message again.';

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

const familyOf = (model: string | null) => (model && /^(?:claude-)?([a-z]+)/.exec(model)?.[1]) || null;

function switchModel(session: Session, name: string, alias: string) {
  const command = `/model ${alias}`;
  void hold(session, { action: 'answer', body: { key: null, text: command }, label: command, command: true }, name, { box: false });
  void hold(session, typed(null, RETRY_TURN, [], null), name, { box: false });
}

function clearingNote(session: Session, folderTask: unknown, repo: RepoView | undefined) {
  const own = repo?.worktrees.find((w) => w.path === session.worktree);
  if (!folderTask && (!own || own.isMain)) return 'Claude is quitting; the task leaves the board once it has.';
  return `Claude quits and ${folderTask ? 'the task folder' : 'the worktree'} is being removed, which takes a while for a large checkout; the task leaves the board once it is gone.`;
}

// Claude is stopped already, so the task stays as the failure left it, and Clear task can be asked again.
function ClearFailed({ session }: { session: Session }) {
  return (
    <section className={styles.blocked} data-clear-error data-ux-section="clear error">
      <div className={styles.errorText}>
        <p><strong>Clear task did not finish.</strong> {session.clearError}</p>
      </div>
      <button type="button" onClick={() => void sessionAction(session.id, 'dismiss-clear-error').catch(reportError)}>Dismiss</button>
      <button type="button" data-variant="primary" onClick={() => askDeleteWorktree(session)}>Clear task…</button>
    </section>
  );
}

function StartFailed({ session }: { session: Session }) {
  const leave = () => {
    closeSheetOf(session.id);
    sessionAction(session.id, 'forget').catch(reportError);
  };
  return (
    <section className={styles.blocked} data-start-failed data-ux-section="start failed">
      <div className={styles.errorText}>
        <p><strong>The task did not start.</strong> Claude never ran.</p>
        <blockquote>{session.starting!.error}</blockquote>
      </div>
      <button type="button" data-variant="primary" data-explain="Open New task with what you sent, to change it or try again; this task makes way" onClick={() => { leave(); editFailedTask(session); }}>Back to New task</button>
      <button type="button" data-explain="Remove this task from the board" onClick={leave}>Remove</button>
    </section>
  );
}

function TurnError({ session, name }: { session: Session; name: string }) {
  const { kind, text } = session.turnError!;
  const said = text.split(/\n\s*\n/)[0].replace(/^API Error:\s*/, '');
  return (
    <section className={styles.blocked} data-turn-error={kind} data-ux-section="turn error">
      <div className={styles.errorText}>
        <p><strong>Claude's turn stopped on an error.</strong> {ERROR_ADVICE[kind]}</p>
        {said && <blockquote data-explain={text}>{said}</blockquote>}
      </div>
      {(kind === 'refusal' || kind === 'login') && <FocusButton session={session} />}
      {kind === 'model' && FAMILIES.filter((f) => f !== familyOf(session.model)).map((alias, i) => (
        <button key={alias} type="button" data-variant={i === 0 ? 'primary' : undefined} {...explain(SENDS.prompt(`/model ${alias}”, then “${RETRY_TURN}`))} onClick={() => switchModel(session, name, alias)}>
          Continue on {modelName(alias)}
        </button>
      ))}
      {kind !== 'refusal' && (
        <button type="button" data-variant={kind === 'model' ? undefined : 'primary'} {...explain(SENDS.prompt(RETRY_TURN))} onClick={() => void hold(session, typed(null, RETRY_TURN, [], null), name)}>Try again</button>
      )}
    </section>
  );
}

// While the open decision sits under a long reply, out of view, a pill at the top says so and scrolls to it.
function DecisionBelow({ scroller, what }: { scroller: RefObject<HTMLDivElement | null>; what: string }) {
  const [below, setBelow] = useState(false);
  useEffect(() => {
    const root = scroller.current;
    const target = root?.querySelector('[data-decision]');
    if (!root || !target) return;
    const seen = new IntersectionObserver(([e]) => setBelow(!e.isIntersecting && e.boundingClientRect.top > (e.rootBounds?.bottom ?? 0)), { root });
    seen.observe(target);
    return () => seen.disconnect();
  }, [scroller]);
  if (!below) return null;
  return (
    <div className={styles.below}>
      <button type="button" data-decision-below data-ux="decision below" onClick={() => scroller.current?.querySelector('[data-decision]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        {what} waiting below
        <Icon name="chevron-down" size={15} />
      </button>
    </div>
  );
}

// The fill shows the gradient up to the share used, so a fuller window reaches the hotter colours.
function ContextGauge({ session }: { session: Session }) {
  const use = contextUse(session);
  if (!use) return '—';
  return (
    <span className={styles.gauge} data-level={use.level} data-explain={`${use.percent}% of the context window: ${use.tokens}`}>
      <span className={styles.gaugeTrack} aria-hidden>
        <span className={styles.gaugeFill} style={{ clipPath: `inset(0 ${100 - Math.min(use.percent, 100)}% 0 0)` }} />
      </span>
      <span className={styles.gaugePercent}>{use.percent}%</span>
    </span>
  );
}

export function Overview({ session, name, branch, repo }: { session: Session; name: string; branch?: string | undefined; repo?: RepoView | undefined }) {
  const { home, repos } = useStore();
  const task = folderTaskOf(repos, session);
  const busy = useBusy();
  const { activity } = session;
  const attention = attentionOf(session);
  const { archived } = session;
  const { clearing } = session;
  const working = session.status === 'working' && !clearing;
  const starting = !!session.starting;
  const message = !archived && !starting && (attention === 'working' || attention === 'idle');
  const ended = attention === 'exited' && !archived && !starting && !session.interrupted;
  // Message Claude stays while focus is in it, also with the window away, whatever the state turns to: a dictation app
  // inserts into the field it started on, and a new box would not be that field. The server refuses a message while
  // Claude shows a prompt, and the text comes back.
  const [writing, setWriting] = useState(false);
  if (archived && writing) setWriting(false);
  const sending = useSending(session);
  const waits = waitingText(session, sending) !== null;
  // What the turn under way answers; a message still queued is not it.
  const trigger = sending || session.unanswered?.queued ? null : session.unanswered?.text ?? session.lastPrompt;
  const artifacts = session.artifacts.toReversed();
  const links = session.links.toReversed();
  const delivered = links.filter((l) => isDelivered(l.url));
  const cited = links.filter((l) => !isDelivered(l.url));
  const scroller = useRef<HTMLDivElement>(null);
  const deciding = !archived && attention === 'decide';
  const { shown, onFocus, onBlur } = useShown(deciding && !busy.has(session.id) ? session : null);
  // After an answer sent from this page, the way on to the next decision shows until the task waits on one again.
  const [answered, setAnswered] = useState(false);
  if (answered && shown) setAnswered(false);
  const sent = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[data-decision]')) scroller.current?.closest<HTMLElement>('#task-sheet')?.focus({ preventScroll: true });
    setAnswered(true);
  };
  const reply = session.lastMessage && (
    <LatestReply key={session.lastMessage} text={session.lastMessage} prompt={session.lastPrompt} previous={waits}>
      <YourMessage session={session} send={sending} inside />
    </LatestReply>
  );
  return (
    <div className={styles.scroll} ref={scroller}>
      {shown && <DecisionBelow scroller={scroller} what={shown.menu ? 'Question' : kindOf(shown) === 'round' ? 'Questions' : 'Decision'} />}
      <div className={styles.grid}>
        <div className={styles.main}>
          {clearing && (
            <section className={styles.working} data-clearing data-ux-section="clearing">
              <span className={styles.spinner} aria-hidden />
              <div className={styles.step}>
                <strong>Clearing the task</strong>
                <span>{clearingNote(session, task, repo)}</span>
              </div>
            </section>
          )}
          {session.clearError && !clearing && <ClearFailed session={session} />}
          {session.interrupted && !archived && !clearing && <Interrupted session={session} name={name} />}
          {stoppedOnError(session, attention) && <TurnError session={session} name={name} />}
          {failedToStart(session) && <StartFailed session={session} />}
          {working && (
            <section className={styles.working} data-ux-section="working">
              <span className={styles.spinner} aria-hidden />
              <div className={styles.step}>
                <strong>{starting ? 'Setting up the task' : activity?.between ? 'Waiting on background work' : 'Claude is working'}</strong>
                {!activity?.between && <code>{activity?.step ?? 'Starting'}</code>}
                {!starting && trigger && <span className={styles.trigger} data-trigger><b>You</b> {trigger}</span>}
                {!!activity?.background?.length && (
                  <ul className={styles.background} aria-label="In the background" data-between={activity.between}>
                    {activity.background.map((b, i) => <li key={i}><code>{b}</code></li>)}
                  </ul>
                )}
              </div>
              {activity && <span className={styles.clock} data-explain="Time since your last message"><Clock since={activity.since} /></span>}
            </section>
          )}
          {(deciding || shown) && reply}
          {shown && (
            <div className={styles.decisionSlot} onFocus={onFocus} onBlur={onBlur}>
              <OpenDecision session={shown} name={name} box={!writing} onSent={sent} />
            </div>
          )}
          {answered && !shown && <NextAfter session={session} />}
          {!archived && attention === 'focus' && (
            <section className={styles.blocked} data-prompt data-ux-section="terminal prompt">
              <p>{menuStuck(session) ? <>Claude still shows <strong>its menu</strong> in the terminal.</> : <>Claude is showing <strong>{session.waitingFor ?? 'a prompt'}</strong> in its terminal.</>} Answer it there.</p>
              <FocusButton session={session} />
            </section>
          )}
          {!deciding && !shown && reply}
          {!session.lastMessage && <YourMessage session={session} send={sending} />}
          {ended && !writing && (
            <section className={styles.blocked} data-ended data-ux-section="ended">
              <p>Claude has ended for this task. <strong>Continue</strong> resumes the conversation in a hidden terminal, and then you can message it here.</p>
              <FocusButton session={session} />
            </section>
          )}
          {(message || (writing && !archived && !clearing)) && (
            <div
              data-ux-section="message box"
              onFocus={() => {
                setWriting(true);
              }}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget) && (e.relatedTarget || document.hasFocus())) {
                  setWriting(false);
                }
              }}
            >
              <Composer
                session={session}
                decision={null}
                label="Message Claude"
                placeholder="Reply, / for commands, paste or drop files…"
                focus={0}
                onSend={(r) => void hold(session, r, name)}
                onEscape={closeSheet}
                actions={<LaterActions session={session} />}
              />
            </div>
          )}
          {!starting && <Later session={session} name={name} />}
        </div>
        <aside className={styles.aside}>
          {session.workflow && (
            <section aria-label="Workflow" data-ux-section="workflow">
              <h3 className={styles.label} data-explain="The phases of the task's rpi workflow, read from its documents in .pitwall/artifacts; each with a document opens it in Documents">Workflow</h3>
              <PhaseStrip session={session.id} workflow={session.workflow} />
            </section>
          )}
          <section aria-label="Facts" data-ux-section="facts">
            <dl className={styles.facts}>
              <dt>Task</dt>
              <dd>{session.firstPrompt ?? '—'}</dd>
              {session.scheduled && (
                <>
                  <dt data-explain="The schedule that started this task">Schedule</dt>
                  <dd data-scheduled>{scheduledNote(session.scheduled)}</dd>
                </>
              )}
              {repo && (
                <>
                  <dt>Repository</dt>
                  <dd>{repo.name}</dd>
                </>
              )}
              {task ? (
                <>
                  <dt data-explain="The folder of repositories the task works across">Folder</dt>
                  <dd>{task.folder}</dd>
                  <dt>Path</dt>
                  <dd><Copy value={session.worktree} shown={tilde(session.worktree, home)} what="Task folder path" /></dd>
                  <dt data-explain="Claude opens a worktree in each repository it changes, on a branch named after the task">Worktrees</dt>
                  <dd data-task-worktrees>
                    {task.worktrees.length ? (
                      <ul className={styles.worktrees}>
                        {task.worktrees.map(({ repo: r, worktree: w }) => (
                          <li key={w.path}>
                            <strong>{r.name}</strong> <Copy value={w.path} shown={tilde(w.path, home)} what={`${r.name} worktree path`} />
                            {w.branch && <> on <Copy value={w.branch} what="Branch" /></>}
                          </li>
                        ))}
                      </ul>
                    ) : 'None yet; Claude opens one in each repository it changes'}
                  </dd>
                </>
              ) : (
                <>
                  <dt>Worktree</dt>
                  <dd>{worktreeName(session.worktree, repo)}</dd>
                  <dt>Path</dt>
                  <dd><Copy value={session.worktree} shown={tilde(session.worktree, home)} what="Worktree path" /></dd>
                </>
              )}
              {branch && (
                <>
                  <dt>Branch</dt>
                  <dd><Copy value={branch} what="Branch" /></dd>
                </>
              )}
              <dt data-explain="The model Claude runs on now and its effort, as its last request named them; /model and /effort change them">Model</dt>
              <dd>{session.model ? modelName(session.model) : '—'}{session.effort && ` ${effortName(session.effort).toLowerCase()}`}</dd>
              <dt data-explain="How much of the model's context window the conversation fills, as Claude's latest request counted it; /compact or /clear frees it">Context</dt>
              <dd data-task-context><ContextGauge session={session} /></dd>
              <dt data-explain="The terminal device Claude runs on">Terminal</dt>
              <dd data-explain="The terminal device Claude runs on">{session.tty ? <code>{session.tty}</code> : '—'}</dd>
              <dt data-explain="Claude Code's session id; claude --resume takes it">Session</dt>
              <dd><Copy value={session.conversation} what="Session id" title="Claude Code's session id; claude --resume takes it" /></dd>
            </dl>
          </section>
          {delivered.length > 0 && (
            <section data-links="delivered" data-ux-section="pull requests and artifacts">
              <h3 className={styles.label} data-explain="The pull requests and claude.ai pages among the links Claude gave in this task, newest first; each opens in your default browser">Pull requests and artifacts</h3>
              <LinkList links={delivered} />
            </section>
          )}
          {cited.length > 0 && (
            <section data-links="cited" data-ux-section="links">
              <h3 className={styles.label} data-explain={`Every ${delivered.length ? 'other ' : ''}web link Claude gave in this task, newest first; each opens in your default browser`}>{delivered.length ? 'Other links' : 'Links'}</h3>
              <LinkList links={cited} />
            </section>
          )}
          {session.history.length > 0 && (
            <section data-ux-section="earlier conversations">
              <h3 className={styles.label} data-explain="The conversations this task had before a /clear started the one it has now; claude --resume takes their ids">Earlier conversations</h3>
              <ul className={styles.history}>
                {session.history.toReversed().map((h) => (
                  <li key={h.id}>
                    <span>Cleared {ago(h.until)}</span>
                    {h.lastMessage && <p>{h.lastMessage}</p>}
                    <Copy value={h.id} what="Session id" title="claude --resume takes it" />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {artifacts.length > 0 && (
            <section data-ux-section="artifacts">
              <h3 className={styles.label} data-explain="Visual explanations Claude made in this session">Artifacts</h3>
              <div className={styles.artifacts}>
                {artifacts.map((a) => (
                  <button key={a.id} type="button" data-ux="artifact" onClick={() => showTab('artifacts', a.id)}>
                    <strong>{a.title}</strong>
                    <span>made {ago(a.at)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
