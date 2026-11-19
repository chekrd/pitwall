import { useNow } from '../now.ts';
import type { Session } from '../types.ts';
import { ago } from '../util.ts';
import parts from './Parts.module.css';

// The branch before a task's name, so a generated title still says which work it is. A task named after its branch
// has it already.
export function BranchMark({ session, branch }: { session: Session; branch: string }) {
  if (!branch || !session.title || session.title === branch) return null;
  return <span className={parts.branch} data-branch data-explain="Branch">{branch}</span>;
}

export function Age({ at, prefix = '' }: { at: number; prefix?: string }) {
  return <>{prefix}{ago(at, useNow())}</>;
}
