import type { Interrupted, Session } from './db.ts';

export const PAUSE_PROMPT = 'Pausing: I am about to close my laptop and move elsewhere. Stop every background task you have running (shells, watchers, monitors, agents), then end your turn. When I resume, I will ask you to start again whatever you stopped.';
export const RESUME_PROMPT = 'Resuming after the pause. Start again the background tasks you stopped, if they are still needed, check where you got to, then carry on.';

// Typed, a pause prompt may wait this long for its turn to start before an idle Claude counts as paused anyway.
const ASKED_MS = 60_000;

type Row = Pick<Session, 'id' | 'status' | 'activity' | 'interrupted'>;

type Step = 'finishing' | 'interrupting' | 'asked' | 'stopping';

interface Stage {
  at: number;
  step: Step;
  since: number;
}

export interface PauseDeps {
  escape: (id: string) => Promise<void>;
  type: (id: string, text: string) => Promise<void>;
  mark: (id: string, paused: Interrupted) => void;
  safe?: () => void;
  now?: () => number;
}

// Between turns with work running in the background, a Claude counts as working but has no turn to finish.
const inTurn = (s: Row) => s.status === 'working' && !s.activity?.between;

export const pauseMark = (at: number): Interrupted => ({ at, status: 'working', waitingFor: null, menu: null, cause: 'pause' });

// Each Claude at work finishes its turn, or has it stopped with Esc on hurry(), and is then asked to stop its
// background tasks itself; it is paused once that turn is over and nothing runs in the background.
export function pauser({ escape, type, mark, safe = () => {}, now = Date.now }: PauseDeps) {
  const stages = new Map<string, Stage>();

  const ask = (id: string, stage: Stage) => {
    Object.assign(stage, { step: 'asked', since: now() });
    void type(id, PAUSE_PROMPT).catch((err) => {
      console.warn('pause prompt failed', id, err);
      stage.step = 'stopping';
    });
  };

  // A turn that starts meanwhile, from a message you sent too, is waited on as well; one you resumed is left alone.
  const follow = (all: Row[]) => {
    for (const s of all.filter((s) => s.status === 'working' && !stages.has(s.id) && s.interrupted?.cause !== 'pause')) {
      const at = now();
      const stage: Stage = { at, step: 'finishing', since: at };
      stages.set(s.id, stage);
      if (!inTurn(s)) ask(s.id, stage);
    }
  };

  function start(all: Row[]) {
    follow(all);
    return { stopping: stages.size };
  }

  async function hurry(all: Row[]) {
    const failed: { id: string; error: string }[] = [];
    for (const [id, stage] of stages) {
      const s = all.find((o) => o.id === id);
      if (stage.step !== 'finishing' || !s || !inTurn(s)) continue;
      try {
        await escape(id);
        stage.step = 'interrupting';
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { failed };
  }

  // Moves each task on from what the latest sync saw; true when one became paused.
  function step(all: Row[]) {
    if (!stages.size) return false;
    follow(all);
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
      else if (stage.step === 'finishing' || stage.step === 'interrupting') {
        if (!inTurn(s) && s.status !== 'waiting') ask(id, stage);
      } else if (stage.step === 'asked') {
        if (inTurn(s)) stage.step = 'stopping';
        else if (s.status === 'idle' && now() - stage.since > ASKED_MS) done();
      } else if (s.status === 'idle') done();
    }
    if (changed && !stages.size) safe();
    return changed;
  }

  return {
    start,
    hurry,
    step,
    stopping: () => [...stages.keys()],
    finishing: () => [...stages].filter(([, s]) => s.step === 'finishing').map(([id]) => id),
    cancel: () => stages.clear(),
  };
}
