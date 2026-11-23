import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ARCHITECTURE_DIR, layout, readModel, refreshCopies, type ModelRoot } from './architecture.ts';

export interface RegenerationRepo {
  key: string;
  name: string;
  main: string;
}

// A task's repositories whose architecture can be regenerated, each in its main checkout, by key.
export interface Regeneration {
  repos: RegenerationRepo[];
  running: string[];
  failed: { key: string; log: string }[];
}

export class RegenerateRefused extends Error {}

export interface RegenerateRun {
  cwd: string;
  prompt: string;
  log: (line: string) => void;
}

export interface RegeneratingDeps {
  roots: (id: string) => ModelRoot[];
  // The repository of a main checkout: its base branch and its other worktrees.
  checkout: (main: string) => { base: string | null; worktrees: string[] };
  logFile: (id: string, repo: string) => string;
  prompt: (repo: RegenerationRepo & { base: string | null }) => string | Promise<string>;
  run: (run: RegenerateRun) => Promise<void>;
  changed: () => void;
}

export function regenerationPrompt(repo: { name: string; main: string; base: string | null }, skill: string) {
  const base = repo.base ?? 'its base branch';
  return [
    `Regenerate the architecture model of the repository ${repo.name} in this checkout, ${repo.main}, which is its main checkout.`,
    `This is the repository's own architecture as on ${base}, not a task's: model what the code here is, not a change to it. Write the model in ${ARCHITECTURE_DIR}/ afresh from the code, keeping the id of an element and the title of a relationship that are still right. The index view's title or description says that this is ${repo.name}'s architecture as on ${base}.`,
    'The skill says to change only a worktree\'s copy, never the main checkout; this run is the one exception, as the developer asked for the main checkout\'s model to be written anew.',
    `You can read the code, write only under ${ARCHITECTURE_DIR}/ and run the check. Do not commit anything.`,
    '',
    'Follow the architecture skill:',
    '',
    skill,
  ].join('\n');
}

// The skill as `pnpm claude:connect` installs it, without its front matter.
export const skillText = (text: string, pitwall: string) => text.replace(/^---\n[\s\S]*?\n---\n+/, '').replaceAll('{{PITWALL}}', pitwall).trim();

function logger(file: string) {
  let chain = mkdir(dirname(file), { recursive: true }).then(() => writeFile(file, ''));
  return {
    line: (text: string) => {
      chain = chain.then(() => appendFile(file, `${text.replace(/\n$/, '')}\n`));
    },
    done: () => chain.catch(() => {}),
  };
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Each run writes one repository's model in its main checkout; a main checkout is written by one run at a time.
export function regenerating(deps: RegeneratingDeps) {
  const busy = new Set<string>();
  const tasks = new Map<string, { running: Set<string>; failed: Map<string, string> }>();
  const taskOf = (id: string) => {
    let t = tasks.get(id);
    if (!t) tasks.set(id, (t = { running: new Set(), failed: new Map() }));
    return t;
  };

  async function regenerate(id: string, repo: RegenerationRepo) {
    const t = taskOf(id);
    const file = deps.logFile(id, repo.name);
    const log = logger(file);
    let ok = false;
    try {
      const replaced = (await readModel(repo.main))?.stamp ?? null;
      const { base, worktrees } = deps.checkout(repo.main);
      log.line(`Regenerating ${repo.name}'s architecture in ${repo.main}, ${new Date().toISOString()}`);
      await deps.run({ cwd: repo.main, prompt: await deps.prompt({ ...repo, base }), log: log.line });
      const model = await readModel(repo.main);
      if (!model) throw new Error(`the run left no model in ${repo.main}/${ARCHITECTURE_DIR}`);
      const { errors } = await layout(model);
      if (errors.length) throw new Error(`the model has errors:\n${errors.map((e) => `${e.file}:${e.line}:${e.column} ${e.message}`).join('\n')}`);
      const copies = await refreshCopies(repo.main, worktrees, replaced);
      log.line(`Done. Worktrees given the new model: ${copies.join(', ') || 'none'}`);
      ok = true;
    } catch (err) {
      log.line(`Failed: ${describe(err)}`);
    } finally {
      await log.done();
      busy.delete(repo.main);
      t.running.delete(repo.key);
      if (!ok) t.failed.set(repo.key, file);
      deps.changed();
    }
  }

  return {
    // Refused as a whole when a repository is unknown or its main checkout is being regenerated; else the runs start
    // and the promise settles once they all ended.
    start(id: string, keys: string[]): Promise<void> {
      const repos = reposOf(deps.roots(id));
      const chosen = [...new Set(keys)].map((key) => {
        const repo = repos.find((r) => r.key === key);
        if (!repo) throw new RegenerateRefused(`this task has no repository ${key || '(its own)'} with a main checkout`);
        return repo;
      });
      if (!chosen.length) throw new RegenerateRefused('pick a repository to regenerate');
      const taken = chosen.find((r) => busy.has(r.main));
      if (taken) throw new RegenerateRefused(`${taken.name}'s architecture is being regenerated already`);
      const t = taskOf(id);
      for (const r of chosen) {
        busy.add(r.main);
        t.running.add(r.key);
        t.failed.delete(r.key);
      }
      deps.changed();
      return Promise.all(chosen.map((r) => regenerate(id, r))).then(() => {});
    },
    of(id: string): Regeneration | null {
      const repos = reposOf(deps.roots(id));
      if (!repos.length) return null;
      const t = tasks.get(id);
      return {
        repos,
        running: repos.filter((r) => t?.running.has(r.key)).map((r) => r.key),
        failed: repos.flatMap((r) => {
          const log = t?.failed.get(r.key);
          return log ? [{ key: r.key, log }] : [];
        }),
      };
    },
  };
}

const reposOf = (roots: ModelRoot[]): RegenerationRepo[] => roots.flatMap((m) => (m.main ? [{ key: m.key, name: m.name, main: m.main }] : []));
