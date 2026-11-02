import type { Interrupted, Session } from './db.ts';

export const PAUSE_PROMPT = 'Pausing: I am about to close my laptop and move elsewhere. Stop every background task you have running (shells, watchers, monitors, agents), then end your turn. When I resume, I will ask you to start again whatever you stopped.';
export const RESUME_PROMPT = 'Resuming after the pause. Start again the background tasks you stopped, if they are still needed, check where you got to, then carry on.';

// Typed, a pause prompt may wait this long for its turn to start before an idle Claude counts as paused anyway.
const ASKED_MS = 60_000;

type Row = Pick<Session, 'id' | 'status' | 'activity'>;

type Step = 'interrupting' | 'asked' | 'stopping';

interface Stage {
  at: number;
  step: Step;
  since: number;
}

export interface PauseDeps {
  escape: (id: string) => Promise<void>;
  type: (id: string, text: string) => Promise<void>;
  mark: (id: string, paused: Interrupted) => void;
  now?: () => number;
}

const busy = (s: Row) => s.status === 'working' && !s.activity?.between;

export const pauseMark = (at: number): Interrupted => ({ at, status: 'working', waitingFor: null, menu: null, cause: 'pause' });

// Esc ends a turn but leaves background work running, so each Claude at work is also asked to stop its background
// tasks itself; it is paused once that turn is over and nothing runs in the background.
export function pauser({ escape, type, mark, now = Date.now }: PauseDeps) {
  const stages = new Map<string, Stage>();

  const ask = (id: string, stage: Stage) => {
    Object.assign(stage, { step: 'asked', since: now() });
    void type(id, PAUSE_PROMPT).catch((err) => {
      console.warn('pause prompt failed', id, err);
      stage.step = 'stopping';
    });
  };

  async function start(all: Row[]) {
    const failed: { id: string; error: string }[] = [];
    for (const s of all.filter((s) => s.status === 'working' && !stages.has(s.id))) {
      const at = now();
      try {
        if (busy(s)) {
          await escape(s.id);
          stages.set(s.id, { at, step: 'interrupting', since: at });
        } else {
          const stage: Stage = { at, step: 'asked', since: at };
          stages.set(s.id, stage);
          ask(s.id, stage);
        }
      } catch (err) {
        failed.push({ id: s.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { stopping: stages.size, failed };
  }

  // Moves each task on from what the latest sync saw; true when one became paused.
  function step(all: Row[]) {
    let changed = false;
    for (const [id, stage] of stages) {
      const s = all.find((o) => o.id === id);
      const done = () => {
        stages.delete(id);
        mark(id, pauseMark(stage.at));
        changed = true;
      };
      if (!s) stages.delete(id);
      else if (s.status === 'exited') done();
      else if (stage.step === 'interrupting') {
        if (!busy(s) && s.status !== 'waiting') ask(id, stage);
      } else if (stage.step === 'asked') {
        if (busy(s)) stage.step = 'stopping';
        else if (s.status === 'idle' && now() - stage.since > ASKED_MS) done();
      } else if (s.status === 'idle') done();
    }
    return changed;
  }

  return {
    start,
    step,
    stopping: () => [...stages.keys()],
    cancel: () => stages.clear(),
  };
}
