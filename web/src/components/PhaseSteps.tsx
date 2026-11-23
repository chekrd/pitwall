import { useState, type ReactNode } from 'react';
import { firstOutdated, IMPLEMENTER_MODELS, nextSteps, reworkStep, stepMessage, type ImplementerModel, type NextStep } from '../../../server/rpi.ts';
import { rpiInvocation } from '../../../server/slash.ts';
import type { Body } from '../outbox.ts';
import { hold } from '../sends.ts';
import type { Command, Session, Workflow } from '../types.ts';
import { modelName } from '../util.ts';
import { useCommands } from './Composer.tsx';
import { explain, SENDS } from './explain.ts';
import { Icon } from './Icon.tsx';
import { askNewCycle } from './NewCycleDialog.tsx';
import picker from './ModelPicker.module.css';
import styles from './PhaseSteps.module.css';

// Why a step cannot go now, or null when it can: only at the end of a turn, as a command typed mid-turn would wait
// for the turn's end, and one typed under a question would answer it.
export function sendBlocked(s: Session, commands: readonly Command[] | null) {
  if (s.archived) return 'The task is archived; unarchive it first.';
  if (s.status === 'exited') return "The task's Claude has ended; continue it first.";
  if (s.status === 'working') return 'Claude is at work; this can go once its turn has ended.';
  if (s.status === 'waiting' || s.menu) return 'Claude is showing a question in its terminal, which this would answer: answer it first.';
  if (!commands) return "Reading Claude's commands…";
  return null;
}

export const stepTip = (step: NextStep) => step.fresh
  ? { ...SENDS.prompt(`/clear”, then, once Claude has started the new conversation, “${step.command}`), sees: "a new conversation: /clear leaves this one behind, and rpi reads the task's documents" }
  : SENDS.prompt(step.command);

export function sendStep(session: Session, name: string, step: NextStep, model: ImplementerModel) {
  const text = stepMessage(step, model);
  const body: Body = { key: null, text };
  if (step.fresh) body.fresh = true;
  if (step.rework) body.rework = step.rework;
  void hold(session, { action: 'answer', body, label: step.fresh ? `/clear, then ${step.command}` : step.command, command: true }, name, { box: false });
}

// The step that reworks the first outdated phase, which comes before any other.
export function firstRework(session: Session, workflow: Workflow, invocation: string) {
  const outdated = session.review.outdated;
  const phase = firstOutdated(workflow, outdated);
  return phase ? reworkStep(workflow, outdated, phase, invocation) : null;
}

// rpi's next steps from the phase under way, each sent as rpi's own command for the task's folder and flow, after a
// /clear when it starts a phase, as rpi runs each phase in a context of its own. While a phase is outdated, its rework
// is the only step. New RPI cycle, last, starts another cycle in the task once this one is done or set aside.
export function PhaseSteps({ session, name, workflow, place }: { session: Session; name: string; workflow: Workflow; place: 'overview' | 'documents' }) {
  const commands = useCommands(session.worktree, true);
  const [model, setModel] = useState<ImplementerModel>('opus');
  const invocation = rpiInvocation(commands ?? []);
  const rework = firstRework(session, workflow, invocation);
  const steps = rework ? [rework] : nextSteps(workflow, invocation);
  const blocked = sendBlocked(session, commands);
  return (
    <div className={styles.steps} data-place={place}>
      {steps.length > 0 && <span className={styles.next} data-next-steps>{steps.map((step) => (
        <Pair key={step.label} with={step === steps.find((s) => s.implements) && (
          <label className={picker.select} data-implementer-model data-explain="The model rpi's implementer writes the code with; the task's own model still reviews and fixes what it hands back">
            <span className={picker.caption}>Implements with</span>
            <select value={model} onChange={(e) => setModel(e.currentTarget.value as ImplementerModel)}>
              {IMPLEMENTER_MODELS.map((m) => <option key={m} value={m}>{modelName(m)}</option>)}
              <option value="">Task's model</option>
            </select>
            <Icon name="chevron-down" size={14} />
          </label>
        )}>
          <button
            type="button"
            data-variant={step.usual ? 'primary' : undefined}
            data-step={step.label}
            data-rework={step.rework}
            disabled={!!blocked}
            {...explain(blocked ? { does: blocked } : stepTip(step))}
            onClick={() => sendStep(session, name, step, model)}
          >
            {step.label}
          </button>
        </Pair>
      ))}</span>}
      <button
        type="button"
        data-new-cycle
        disabled={!!blocked}
        {...explain(blocked ? { does: blocked } : {
          ...SENDS.prompt(''),
          does: "Asks for a new request, then sends /clear and rpi on it in the same worktree and branch, with its documents in a folder of their own, with 5 s to undo. This cycle's documents stay under Earlier cycles in Documents.",
          sees: 'a new conversation: /clear leaves this one behind, and rpi starts on the request',
        })}
        onClick={() => askNewCycle(session, name)}
      >
        New RPI cycle
      </button>
    </div>
  );
}

const Pair = ({ with: lead, children }: { with: ReactNode; children: ReactNode }) =>
  lead ? <span className={styles.pair}>{lead}{children}</span> : children;
