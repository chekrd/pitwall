import type { Check } from '../helpers.ts';
import { board } from './board.ts';
import { builds } from './builds.ts';
import { clientShell } from './clientShell.ts';
import { dialogs } from './dialogs.ts';
import { dock } from './dock.ts';
import { layout } from './layout.ts';
import { newTask } from './newTask.ts';
import { queueCard } from './queueCard.ts';
import { replies } from './replies.ts';
import { restart } from './restart.ts';
import { schedulesLater } from './schedulesLater.ts';
import { sends } from './sends.ts';
import { taskPage } from './taskPage.ts';
import { usageFindings } from './usageFindings.ts';
import { wall } from './wall.ts';

export const checks: Check[] = [
  ...board,
  ...builds,
  ...wall,
  ...taskPage,
  ...newTask,
  ...dialogs,
  ...queueCard,
  ...sends,
  ...replies,
  ...dock,
  ...layout,
  ...clientShell,
  ...usageFindings,
  ...restart,
  ...schedulesLater,
];
