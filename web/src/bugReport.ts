import { api, upload } from './api.ts';
import { record, recorded, snapshot, started } from './recorder.ts';
import type { RepoView, Session } from './types.ts';

type Snapshot = ReturnType<typeof snapshot>;

const sessionOf = (s: Session) => ({
  id: s.id, title: s.title, worktree: s.worktree, status: s.status, waitingFor: s.waitingFor, archived: s.archived, question: s.question?.title ?? null, menu: !!s.menu, updatedAt: s.updatedAt,
});

export const stampOf = (at: Date) => at.toISOString().replace(/\D/g, '').slice(4, 14);

export function buildReport({ comment, taken, sessions, link }: { comment: string; taken: Snapshot; sessions: Session[]; link: string }) {
  return {
    note: 'Events oldest first: [ms since page load, type, detail, active element, window focused]. Elements read tag#serial; a new serial for an element means it remounted. `snapshot` is the page when the report was opened (snapshot.ms on the same clock); events after it are the report dialog itself.',
    comment,
    pageLoaded: new Date(started).toISOString(),
    filedMs: Math.round(performance.now()),
    link,
    snapshot: taken,
    sessions: sessions.map(sessionOf),
    userAgent: navigator.userAgent,
    events: recorded(),
  };
}

// A fence longer than any run of backticks in the comment, so the comment reads back exactly as written.
function fenced(text: string) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

export function bugPrompt(comment: string, report: string) {
  const said = comment.trim()
    ? `What I wrote about it, word for word:\n\n${fenced(comment)}`
    : 'I wrote nothing about it, so the report has to show what went wrong: look at what happened just before I opened the report.';
  return [
    'I filed a bug report from the Pitwall board, right after something went wrong on it.',
    said,
    `The report is ${report} (JSON). \`events\` are the board's last few thousand focus, key, paste, input, route, state, request and error events, oldest first; \`snapshot\` is the page at the moment I opened the report, with its text, its open dialogs and every reply box; \`sessions\` are the tasks on the board. The recorder is web/src/recorder.ts.`,
    'Find the cause from the evidence. Reproduce the bug in pnpm e2e, fix it, and deliver the fix to main the way other Pitwall work is delivered (commit on main, push, pnpm build, pnpm service:restart if the server changed).',
    'If the evidence does not explain what went wrong, stop and tell me so, with what the report does and does not show. Do not guess at a fix.',
  ].join('\n\n');
}

// The report goes to the Pitwall repository as a new task. When the board cannot file it (the server is down, or
// Pitwall is not on the board), the report is saved as a download instead, with the prompt it would have started.
export async function fileBugReport({ comment, taken, sessions, repos, pitwall, link }: { comment: string; taken: Snapshot; sessions: Session[]; repos: RepoView[]; pitwall: string; link: string }) {
  record('bug-report', { commentLength: comment.length });
  const stamp = stampOf(new Date());
  const name = `bug-${stamp}`;
  const report = buildReport({ comment, taken, sessions, link });
  try {
    const repo = repos.find((r) => r.path === pitwall || r.worktrees.some((w) => w.path === pitwall));
    if (!repo) throw new Error('the Pitwall repository is not on the board');
    const path = await upload(new File([JSON.stringify(report, null, 1)], `${name}.json`, { type: 'application/json' }));
    const created = await api<{ path: string; sessionId: string | null }>('POST', '/api/worktrees', { repoId: repo.id, name, prompt: bugPrompt(comment, path) });
    return { filed: true as const, session: created.sessionId };
  } catch (err) {
    const file = `${name}.json`;
    const saved = { ...report, error: (err as Error).message, prompt: bugPrompt(comment, `this file (${file} in Downloads)`) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 1)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: file });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { filed: false as const, file, error: (err as Error).message };
  }
}
