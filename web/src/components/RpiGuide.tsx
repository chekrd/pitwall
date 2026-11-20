import { Fragment, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { FLOWS, PHASE_LABELS, type Flow, type Phase } from '../../../server/rpi.ts';
import { keepUnderLayer } from '../layers.ts';
import type { Workflow } from '../types.ts';
import styles from './RpiGuide.module.css';

const DIALOG = 'rpi-guide';

type Mark = Pick<Workflow, 'flow' | 'current'> | null;

let mark: (m: Mark) => void = () => {};

export function openRpiGuide(at: Mark) {
  const dialog = document.getElementById(DIALOG) as HTMLDialogElement | null;
  if (!dialog || dialog.open) return;
  flushSync(() => mark(at));
  dialog.showModal();
  dialog.focus();
}

export function RpiGuideButton({ workflow }: { workflow: Workflow | null }) {
  return (
    <button
      type="button"
      data-variant="ghost"
      className={styles.open}
      data-rpi-guide-open
      data-explain="What each rpi phase is for, what you review in it, and which flow suits which change"
      onClick={() => openRpiGuide(workflow && { flow: workflow.flow, current: workflow.current })}
    >
      How RPI works
    </button>
  );
}

interface Entry {
  id: Phase | 'design';
  name: string;
  aside?: string;
  writes: string;
  check: string;
  not: string;
}

const PHASES: Entry[] = [
  {
    id: 'questions',
    name: 'Research questions',
    aside: 'Questions on the strip',
    writes: 'Focused questions about how the code works today, with the files to start from. Your request is saved in a document of its own.',
    check: 'The scope: is anything missing or beside the point?',
    not: 'Ask what to change. The questions describe the system as it is.',
  },
  {
    id: 'research',
    name: 'Research',
    writes: 'Answers from the live code, tests and docs, with file references.',
    check: 'The facts: is this how the code really works?',
    not: 'Propose the change. It leaves your request aside, so the findings stay neutral.',
  },
  {
    id: 'design',
    name: 'Design',
    aside: 'one of three, by flow',
    writes: 'The change itself: options with trade-offs and a recommendation, and the one you pick. Claude asks one decision at a time and waits for your answer.',
    check: 'Each choice, then the whole document.',
    not: 'Write code.',
  },
  {
    id: 'outline',
    name: 'Outline',
    aside: 'optional',
    writes: 'The agreed design split into ordered phases, each with its result, files, tests, and automated and manual checks.',
    check: 'The scope and the order of the phases.',
    not: 'Change the approach. It decides the order of the work, not what the work is.',
  },
  {
    id: 'implement',
    name: 'Implement',
    writes:
      'Code and tests, though not by the conversation itself: it hands the work to rpi\'s implementer, a subagent that starts with an empty context and reads only the documents, then checks what comes back. With an outline, each phase goes to a new implementer and is ticked off in the outline; without one, the whole change goes to one implementer in one run.',
    check: 'The checks it ran, then test it yourself. It pauses for the manual checks of a phase.',
    not: 'Redesign. Where the code and the design disagree on the result, it asks you.',
  },
];

const DESIGNS: { id: Phase; name: string; text: string }[] = [
  { id: 'design-discussion', name: 'Design discussion', text: 'Product and technical choices together: where things are, where they should be, the options and the agreed one.' },
  { id: 'prd', name: 'PRD', text: 'Product requirements: the problem, how you will tell it helped, and the solution as users see it. Technical questions wait for the technical design.' },
  {
    id: 'tdd',
    name: 'Technical design',
    text: 'rpi calls it a TDD: a technical design document, not test-driven development. First how the components interact, then the shape of the code and tests, each approved on its own.',
  },
];

const FLOW_ROWS: { flow: Flow; name: string; use: string }[] = [
  { flow: 'design-discussion', name: 'Design discussion', use: 'A change with a few clear options.' },
  { flow: 'prd', name: 'PRD, then technical design', use: 'A larger feature with open product questions.' },
  { flow: 'tdd', name: 'Technical design', use: 'Fixes, cleanup and refactoring, where the wanted behaviour is clear.' },
  { flow: 'research-only', name: 'Research only', use: 'The research is enough: implement from it.' },
];

const DESIGN_PHASES: Phase[] = ['design', 'design-discussion', 'prd', 'tdd'];

const Here = () => <span className={styles.here}>This task</span>;

export function RpiGuide() {
  const [at, setAt] = useState<Mark>(null);
  useEffect(() => {
    mark = setAt;
    return () => {
      mark = () => {};
    };
  }, []);
  const current = at?.current ?? null;
  const entryOf = (p: Phase | null) => (p && DESIGN_PHASES.includes(p) ? 'design' : p);

  return (
    <dialog id={DIALOG} closedby="any" tabIndex={-1} aria-labelledby="rpi-guide-title" className={styles.dialog} onCancel={keepUnderLayer} onClose={() => setAt(null)}>
      <header>
        <h2 id="rpi-guide-title">How RPI works</h2>
        <button type="button" commandfor={DIALOG} command="close">
          Close <kbd>Esc</kbd>
        </button>
      </header>
      <p className={styles.lead}>
        HumanLayer's rpi skill takes a change through research, design and implementation. Each phase runs in a new conversation and ends in a document you review
        before the next one starts: the documents carry the context from phase to phase, not the chat.
      </p>

      <section aria-labelledby="rpi-guide-phases">
        <h3 id="rpi-guide-phases">The phases</h3>
        <ol className={styles.phases}>
          {PHASES.map((p) => (
            <li key={p.id} data-guide-phase={p.id} data-here={entryOf(current) === p.id || undefined}>
              <h4>
                {p.name}
                {p.aside && <span className={styles.aside}>{p.aside}</span>}
                {entryOf(current) === p.id && <Here />}
              </h4>
              <dl>
                <dt>Writes</dt>
                <dd>{p.writes}</dd>
                {p.id === 'design' && (
                  <dd className={styles.designs}>
                    <ul>
                      {DESIGNS.map((d) => (
                        <li key={d.id} data-guide-design={d.id} data-here={current === d.id || undefined}>
                          <strong>{d.name}</strong> {d.text}
                          {current === d.id && <> <Here /></>}
                        </li>
                      ))}
                    </ul>
                  </dd>
                )}
                <dt>You check</dt>
                <dd>{p.check}</dd>
                <dt>Does not</dt>
                <dd>{p.not}</dd>
              </dl>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="rpi-guide-flows">
        <h3 id="rpi-guide-flows">Which flow</h3>
        <p>Every flow starts with research questions and research; they differ in the design step. A dashed phase is optional.</p>
        <ul className={styles.flows}>
          {FLOW_ROWS.map((f) => (
            <li key={f.flow} data-guide-flow={f.flow} data-here={at?.flow === f.flow || undefined}>
              <div className={styles.flowHead}>
                <strong>{f.name}</strong>
                {at?.flow === f.flow && <Here />}
              </div>
              <p>{f.use}</p>
              <ol className={styles.path} aria-label={`${f.name}: the phases`}>
                {FLOWS[f.flow].map((p, i) => (
                  <Fragment key={p}>
                    {i > 0 && <li aria-hidden className={styles.arrow}>→</li>}
                    <li className={styles.chip} data-optional={p === 'outline' || undefined} data-here={(at?.flow === f.flow && current === p) || undefined}>
                      {PHASE_LABELS[p]}
                      {p === 'outline' && <span className={styles.hidden}> (optional)</span>}
                    </li>
                  </Fragment>
                ))}
              </ol>
            </li>
          ))}
        </ul>
        <p>
          Implementation can start after any step once its document specifies the task well enough. The outline is optional: a small fix in one place can go
          straight to Implement, and a PRD can go straight to an outline or to Implement.
        </p>
      </section>

      <section aria-labelledby="rpi-guide-board">
        <h3 id="rpi-guide-board">On the board</h3>
        <ul className={styles.board}>
          <li>The phase strip shows where the task is; a phase with a document opens it in Documents.</li>
          <li>
            The highlighted next step is the flow's usual one; the others are shortcuts rpi allows. Right after the research with no flow chosen, none is
            highlighted.
          </li>
          <li>
            Every step sends <code>/clear</code>, then rpi's command for the task's folder, so each phase starts in a new conversation; only{' '}
            <strong>Implement the next phase</strong> stays in the conversation: each outline phase goes to a new implementer anyway, and the conversation keeps what you said while checking the last one. Steps go only at the end of a turn.
          </li>
          <li>Select a passage in Documents to comment on it; <strong>Send comments</strong> has rpi update that document from them.</li>
          <li><strong>Implements with</strong>, beside Implement, picks the model rpi's implementer writes the code with; the task's own model reviews what it hands back.</li>
        </ul>
      </section>
    </dialog>
  );
}
