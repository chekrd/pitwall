import { useEffect } from 'react';
import { BugReportDialog } from './components/BugReportDialog.tsx';
import { DriftBanner } from './components/DriftBanner.tsx';
import { DeleteWorktreeDialog } from './components/DeleteWorktreeDialog.tsx';
import { KeysDialog } from './components/KeysDialog.tsx';
import { NewTaskDialog } from './components/NewTaskForm.tsx';
import { RestartBanner } from './components/RestartBanner.tsx';
import { RpiGuide } from './components/RpiGuide.tsx';
import { TaskSheet } from './components/TaskSheet.tsx';
import { TerminalNoticeBanner } from './components/TerminalNoticeBanner.tsx';
import { Toasts } from './components/Toasts.tsx';
import { TopBar } from './components/TopBar.tsx';
import { Wall } from './components/Wall.tsx';
import { WorkspaceDialog } from './components/WorkspaceDialog.tsx';
import { nextDecision, waitingOf } from './order.ts';
import { useRoute } from './router.ts';
import { useBusy } from './sends.ts';
import { useStore } from './store.ts';
import { useBoardKeys } from './useKeys.ts';
import { setBoard } from './ux.ts';

export function App() {
  const store = useStore();
  const route = useRoute();
  const waiting = waitingOf(store.sessions, useBusy());
  const next = nextDecision(waiting, route.sheet?.id ?? null);
  const sheetSession = route.sheet && store.sessions.find((s) => s.id === route.sheet!.id);

  useEffect(() => {
    const live = store.sessions.filter((s) => !s.archived);
    const names = [
      ...store.sessions.flatMap((s) => [s.title, s.worktree.split('/').at(-1)]),
      ...store.repos.flatMap((r) => [r.name, ...r.worktrees.flatMap((w) => [w.branch, w.path.split('/').at(-1)])]),
      ...store.folders.map((f) => f.name),
    ];
    setBoard({ tasks: live.length, waiting: waiting.length, names: names.filter((n): n is string => !!n) });
  }, [store.sessions, store.repos, store.folders, waiting.length]);

  useBoardKeys({ route, next: next.next?.id ?? null, repos: store.repos.length > 0, artifacts: !!sheetSession?.artifacts.length, documents: !!sheetSession?.workflow, architecture: !!sheetSession?.architecture });

  return (
    <>
      <TopBar next={next} />
      <RestartBanner />
      <DriftBanner />
      <TerminalNoticeBanner />
      {/* Under an open task the Wall stays, so it comes back as it was left. */}
      <div className="views">
        <div className="view" data-covered={!!route.sheet || undefined} inert={!!route.sheet}>
          <Wall waiting={waiting} />
        </div>
        <TaskSheet route={route} />
      </div>
      <NewTaskDialog repos={store.repos} />
      <WorkspaceDialog roots={store.roots} repos={store.repos} sessions={store.sessions} />
      <KeysDialog />
      <RpiGuide />
      <BugReportDialog />
      <DeleteWorktreeDialog />
      <Toasts />
    </>
  );
}
