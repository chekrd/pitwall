import { useState, type ReactNode } from 'react';
import { IMPLEMENTER_MODELS, nextSteps, stepMessage, type ImplementerModel, type NextStep } from '../../../server/rpi.ts';
import { rpiInvocation } from '../../../server/slash.ts';
import { hold } from '../sends.ts';
import type { Command, Session, Workflow } from '../types.ts';
import { modelName } from '../util.ts';
import { fileName, plural, useComments } from './Comments.tsx';
import { useCommands } from './Composer.tsx';
import { explain, SENDS } from './explain.ts';
import { Icon } from './Icon.tsx';
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

const tip = (step: NextStep) => step.fresh
  ? { ...SENDS.prompt(`/clear”, then, once Claude has started the new conversation, “${step.command}`), sees: "a new conversation: /clear leaves this one behind, and rpi reads the task's documents" }
  : SENDS.prompt(step.command);

// rpi's next steps from the phase under way, each sent as rpi's own command for the task's folder and flow, after a
// /clear when it starts a phase, as rpi runs each phase in a context of its own.
export function PhaseSteps({ session, name, workflow, place }: { session: Session; name: string; workflow: Workflow; place: 'overview' | 'documents' }) {
  const commands = useCommands(session.worktree, true);
  const comments = useComments(session);
  const [model, setModel] = useState<ImplementerModel>('opus');
  const steps = nextSteps(workflow, rpiInvocation(commands ?? []));
  if (!steps.length) return null;
  const blocked = sendBlocked(session, commands);
  const current = workflow.steps.find((s) => s.state === 'current')?.document;
  const open = current ? comments.filter((c) => c.ref.path === current).length : 0;
  const send = (step: NextStep) => {
    const text = stepMessage(step, model);
    const body = step.fresh ? { key: null, text, fresh: true } : { key: null, text };
    void hold(session, { action: 'answer', body, label: step.fresh ? `/clear, then ${step.command}` : step.command, command: true }, name, { box: false });
  };
  return (
    <div className={styles.steps} data-place={place} data-next-steps>
      {open > 0 && (
        <span className={styles.unsent} data-unsent-comments data-explain={`The ${fileName(current!)} document has comments under Later that Claude has not had yet`}>
          {plural(open, 'comment')} not sent
        </span>
      )}
      {steps.map((step) => (
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
          <button type="button" data-variant={step.usual ? 'primary' : undefined} data-step={step.label} disabled={!!blocked} {...explain(blocked ? { does: blocked } : tip(step))} onClick={() => send(step)}>
            {step.label}
          </button>
        </Pair>
      ))}
    </div>
  );
}

const Pair = ({ with: lead, children }: { with: ReactNode; children: ReactNode }) =>
  lead ? <span className={styles.pair}>{lead}{children}</span> : children;
