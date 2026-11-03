import { useStore } from '../store.ts';
import type { Drift } from '../types.ts';
import { openNewTask } from './NewTaskForm.tsx';
import styles from './RestartBanner.module.css';

const fixPrompt = (drift: Drift[], versions: string[]) => `Pitwall reports that Claude Code${versions.length ? ` ${versions.join(', ')}` : ''} changed a file it reads without a documented format:

${drift.map((d) => `- ${d.problem}`).join('\n')}

The checks that noticed it are in server/claudeFormat.ts and their callers. Look at the real files under ~/.claude (session files in ~/.claude/sessions, transcripts in ~/.claude/projects) to see what changed, then update Pitwall to read the new format, or fix the check if it is a false alarm. Keep the drift checks and their tests in step.`;

// Claude Code changed a file Pitwall reads without a documented format, so tasks may show stale or wrong states.
export function DriftBanner() {
  const { drift, repos, pitwall } = useStore();
  if (!drift.length) return null;
  const versions = [...new Set(drift.flatMap((d) => (d.version ? [d.version] : [])))];
  const repo = repos.find((r) => r.path === pitwall || r.worktrees.some((w) => w.path === pitwall));
  return (
    <section className={styles.banner} data-drift aria-live="polite">
      <p>
        <strong>Claude Code{versions.length ? ` ${versions.join(', ')}` : ''} changed what Pitwall reads</strong>: {drift.map((d) => d.problem).join('; ')}.
        {' '}Tasks may show a stale state until Pitwall is updated for it.
      </p>
      {repo && (
        <button type="button" data-variant="primary" data-fix-drift onClick={() => openNewTask({ repoId: repo.id, name: 'claude-code-drift', prompt: fixPrompt(drift, versions) })} data-explain="Opens New task on Pitwall's repository with a prompt that asks Claude to update Pitwall for the change">
          Fix it
        </button>
      )}
    </section>
  );
}
