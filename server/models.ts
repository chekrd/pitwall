import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

export const ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface Settings {
  model?: string;
  effortLevel?: string;
  modelSettings?: Record<string, { effortLevel?: string }>;
}

interface Seen {
  model: string | null;
  effort: string | null;
  // One of the board's own claude -p runs: it tells what an alias comes to, not what the developer picked.
  headless?: boolean;
}

const RAN_FILE = join(DATA_DIR, 'models.json');

type Ran = Record<string, { model: string; updatedAt: number }>;

let ran: Ran | null = null;

const loadRan = (): Ran => {
  if (ran) return ran;
  try {
    ran = JSON.parse(readFileSync(RAN_FILE, 'utf8')) as Ran;
  } catch {
    ran = {};
  }
  return ran;
};

// The models a claude -p run reports using, kept per family from when each was first seen.
export function noteRan(models: string[], at = Date.now()) {
  const known = loadRan();
  let changed = false;
  for (const model of models) {
    const family = /^claude-([a-z]+)-/.exec(model)?.[1];
    if (!family || known[family]?.model === model) continue;
    known[family] = { model, updatedAt: at };
    changed = true;
  }
  if (changed) void writeFile(RAN_FILE, JSON.stringify(known)).catch(() => {});
}

export const ranHeadless = () => Object.values(loadRan()).map((r) => ({ ...r, effort: null, headless: true }));

const read = (file: string): Promise<Settings> => readFile(file, 'utf8').then((t) => JSON.parse(t) as Settings, () => ({}));

// The layers Claude Code reads for a session started in the repository, the later ones winning.
export async function settingsFor(repoPath: string): Promise<Settings> {
  const layers = await Promise.all([
    join(homedir(), '.claude', 'settings.json'),
    join(repoPath, '.claude', 'settings.json'),
    join(repoPath, '.claude', 'settings.local.json'),
  ].map(read));
  return layers.reduce((a, b) => ({ ...a, ...b, modelSettings: { ...a.modelSettings, ...b.modelSettings } }), {});
}

const LONG = '[1m]';
const bare = (model: string) => model.replace(LONG, '');

// What a model name and the effort for it come to, from the settings and, for an alias or what the settings leave
// open, from the sessions seen running (newest first): Claude Code resolves aliases itself and does not say to what.
export function resolver(settings: Settings, seen: Seen[]) {
  const ids = seen.flatMap((s) => (s.model ? [bare(s.model)] : []));
  const real = (name: string) => {
    const base = bare(name);
    if (!ALIASES.includes(base)) return name;
    const id = ids.find((m) => m.startsWith(`claude-${base}-`));
    return id ? `${id}${name.endsWith(LONG) ? LONG : ''}` : name;
  };
  const picked = seen.find((s) => s.model && !s.headless)?.model;
  const model = settings.model ? real(settings.model) : picked ? bare(picked) : null;
  const effortOf = (name: string | null) => {
    if (!name) return null;
    const id = bare(name);
    return settings.modelSettings?.[id]?.effortLevel ?? settings.effortLevel ?? seen.find((s) => s.effort && s.model && bare(s.model) === id)?.effort ?? null;
  };
  return { model, real, effortOf };
}
