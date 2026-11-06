import { serve } from '@hono/node-server';
import { createApp, socketServer, UI_INDEX } from './app.ts';
import { onDrift } from './claudeFormat.ts';
import { settleExplanations } from './explain.ts';
import { HOST, PORT, USAGE_FILE } from './config.ts';
import { schedules, uxEvents } from './db.ts';
import { sync } from './ingest.ts';
import { untilNextMinute } from './schedule.ts';
import * as S from './sessions.ts';
import { plan } from './tasks.ts';
import { readEntry, watchEntry } from './uiEntry.ts';
import { keepUploads } from './uploads.ts';
import { watchUsage } from './usage.ts';
import { KEEP_DAYS } from './uxlog.ts';
import { notify, onChange, refreshWorkspace } from './workspace.ts';

process.on('unhandledRejection', (err) => console.error('unhandled rejection', err));

const usage = watchUsage(USAGE_FILE, notify);
onDrift(notify);
const ui = watchEntry(() => readEntry(UI_INDEX), notify);
const app = createApp({ usage, ui });

keepUploads(() => schedules.all().flatMap((s) => s.task.files ?? []));
onChange(S.sendDueDrafts);

const pruneUx = () => uxEvents.prune(Date.now() - KEEP_DAYS * 86_400_000);
pruneUx();
setInterval(pruneUx, 86_400_000).unref();

await refreshWorkspace({ scan: true });
await sync();
S.settleAsides();
S.settleStarting();
settleExplanations();
setInterval(() => void sync().then(() => {
  S.pauseStep();
  S.sendDueDrafts();
}).catch((err) => console.warn('session sync failed', err)), 1500);
setInterval(() => void refreshWorkspace({ scan: true }).catch((err) => console.warn('workspace refresh failed', err)), 30_000);

serve({ fetch: app.fetch, hostname: HOST, port: PORT, websocket: { server: socketServer() } }, () => {
  console.log(`pitwall listening on http://${HOST}:${PORT}`);
  // Only now, as the Claude a schedule starts connects to the MCP server here. A timer does not run while the Mac
  // sleeps; the first look after it wakes starts what came due meanwhile.
  const look = () => {
    void plan.step().catch((err) => console.warn('schedules failed', err));
    setTimeout(look, untilNextMinute(Date.now()));
  };
  look();
});
