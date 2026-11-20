import type { MouseEvent } from 'react';
import { PHASE_LABELS, phaseLabel, type StepState } from '../../../server/rpi.ts';
import { sessionPath, showTab } from '../router.ts';
import type { Workflow, WorkflowStep } from '../types.ts';
import styles from './Workflow.module.css';

// A document's place in the Documents tab, as one route segment.
export const documentItem = (path: string) => encodeURIComponent(path);

const STATE_WORDS: Record<StepState, string> = { done: 'Done', current: 'Under way', next: 'Not yet', skipped: 'Skipped' };

const fileName = (path: string) => path.split('/').at(-1);

function explain(step: WorkflowStep, workflow: Workflow) {
  const progress = step.phase === 'implement' && workflow.outline
    ? `: ${workflow.outline.done} of ${workflow.outline.total} ${workflow.outline.unit === 'phase' ? 'phases of the outline' : 'checks of the outline'} done`
    : '';
  const doc = step.document && step.phase !== 'implement' ? `, ${fileName(step.document)}` : '';
  return `${STATE_WORDS[step.state]}${progress}${doc}`;
}

// The workflow's phases as rpi's documents tell them, done, under way or not yet; each with a document opens it in
// the Documents tab. Orientation only: nothing here reaches Claude.
export function PhaseStrip({ session, workflow }: { session: string; workflow: Workflow }) {
  const open = (e: MouseEvent<HTMLAnchorElement>, path: string) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    showTab('documents', documentItem(path));
  };
  return (
    <ol className={styles.strip} aria-label="Workflow phases" data-phase-strip>
      {workflow.steps.map((step) => {
        const label = (
          <>
            {PHASE_LABELS[step.phase]}
            {step.phase === 'implement' && workflow.outline && <span className={styles.count}>{workflow.outline.done}/{workflow.outline.total}</span>}
          </>
        );
        return (
          <li key={step.phase} data-state={step.state} data-phase={step.phase} aria-current={step.state === 'current' ? 'step' : undefined} data-explain={explain(step, workflow)}>
            {step.document
              ? <a href={sessionPath(session, 'documents', documentItem(step.document))} onClick={(e) => open(e, step.document!)}>{label}</a>
              : <span>{label}</span>}
          </li>
        );
      })}
    </ol>
  );
}

// The Wall tile's word on where the workflow is.
export function PhaseChip({ workflow }: { workflow: Workflow }) {
  const label = phaseLabel(workflow);
  if (!label) return null;
  return <span className={styles.chip} data-workflow-chip data-explain="Where the task's rpi workflow is, by its documents">RPI · {label}</span>;
}
