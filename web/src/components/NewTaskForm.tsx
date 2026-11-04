import { useActionState, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ToggleEvent } from 'react';
import { api } from '../api.ts';
import { track } from '../ux.ts';
import { keepUnderLayer } from '../layers.ts';
import { openSheet } from '../router.ts';
import type { FolderView, RepoView } from '../types.ts';
import { useStore } from '../store.ts';
import { DAYS, describeWhen } from '../schedules.ts';
import type { When } from '../types.ts';
import { toast } from './Toasts.tsx';
import { EFFORTS, effortName, modelName, tilde, untilde } from '../util.ts';
import { AttachButton, AttachedFiles, draftOf, editDraft, readyPaths, release, takesFiles, uploading, useDraft } from './Composer.tsx';
import { Icon } from './Icon.tsx';
import styles from './NewTaskForm.module.css';

interface Fields {
  prompt: string;
  repoId: number | null;
  // A folder of repos picked instead of one repository: Claude decides which of them to open worktrees in.
  folder: string | null;
  name: string;
  branch: string;
  path: string;
  existing: boolean;
  model: string;
  effort: string;
  // The prompt, model and effort, folded away by default since a task usually starts without them.
  more: boolean;
  // Now, or a schedule: once at `at` (a datetime-local value), or at `time` on `days` (0 is Sunday).
  start: 'now' | 'once' | 'repeat';
  at: string;
  time: string;
  days: number[];
}

// What each choice of model comes to, '' being what Claude Code picks by itself, and the effort it starts with.
interface Models {
  models: Record<string, string | null>;
  efforts: Record<string, string | null>;
}

interface Branch {
  name: string;
  local: boolean;
  origin: boolean;
  worktree: string | null;
}

const DIALOG = 'new-task';
const STORED = 'pitwall:new-task';
const CHOICES = 'pitwall:new-task-choices';
const WHEN = { start: 'now', at: '', time: '09:00', days: [1, 2, 3, 4, 5] } as const satisfies Partial<Fields>;
const EMPTY: Fields = { prompt: '', repoId: null, folder: null, name: '', branch: '', path: '', existing: true, model: '', effort: '', more: false, ...WHEN, days: [...WHEN.days] };
const choicesOf = ({ repoId, folder, existing, model, effort, more }: Fields) => ({ repoId, folder, existing, model, effort, more });

const NAME = /^[A-Za-z0-9._/-]+$/;
// Monday first.
const WEEK = [1, 2, 3, 4, 5, 6, 0];

const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
// The next whole hour, at least ten minutes away.
const soon = () => {
  const d = new Date(Date.now() + 10 * 60_000);
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return localInput(d);
};

function whenOf(f: Fields): When | null {
  if (f.start === 'once') {
    const at = new Date(f.at).getTime();
    return Number.isFinite(at) && at > Date.now() ? { at } : null;
  }
  if (f.start === 'repeat') return /^\d\d:\d\d$/.test(f.time) && f.days.length ? { time: f.time, days: f.days.toSorted((a, b) => a - b) } : null;
  return null;
}
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const read = (storage: () => Storage, key: string) => {
  try {
    return JSON.parse(storage().getItem(key) ?? '{}');
  } catch {
    return {};
  }
};

function stored(): Fields {
  const { prompt, branch, path, time, days } = read(() => sessionStorage, STORED);
  const draft = { prompt: prompt ?? '', branch: branch ?? '', path: path ?? '', time: time ?? WHEN.time, days: days ?? [...WHEN.days] };
  return { ...EMPTY, ...read(() => localStorage, CHOICES), ...draft };
}

// A prompt begun and closed is there when New task opens again, and a reload keeps it; the name starts empty and Start
// on Now each time.
// The repository, the mode, the model and effort and whether More is open outlast the tab, as the next task usually
// starts where the last one did.
let fields = stored();
// They share the branch list too: both are mounted at once, and one read serves them.
let branches: { repoId: number; list: Branch[] } | null = null;
let reading: number | null = null;
// Each opening reads the branches again, so one fetched or pushed since shows.
let opened = 0;
let models: { key: string; read: Models } | null = null;
let readingModels: string | null = null;
const subscribers = new Set<() => void>();

const notify = () => {
  for (const fn of subscribers) fn();
};

function edit(patch: Partial<Fields>) {
  fields = { ...fields, ...patch };
  try {
    const { prompt, branch, path, time, days } = fields;
    sessionStorage.setItem(STORED, JSON.stringify({ prompt, branch, path, time, days }));
    localStorage.setItem(CHOICES, JSON.stringify(choicesOf(fields)));
  } catch {
    // A page without storage keeps them in memory only.
  }
  notify();
}

function readBranches(repoId: number) {
  if (reading === repoId) return;
  reading = repoId;
  void api('GET', `/api/repos/${repoId}/branches`).catch(() => []).then((list) => {
    if (reading !== repoId) return;
    reading = null;
    branches = { repoId, list: list.toSorted((a, b) => byName(a.name, b.name)) };
    notify();
  });
}

// `key` is the target's: what a model resolves to depends on the settings of the folder Claude starts in.
function readModels(key: string, url: `/api/repos/${number}/models` | `/api/folders/models?path=${string}`) {
  if (readingModels === key || models?.key === key) return;
  readingModels = key;
  void api('GET', url).catch(() => ({ models: {}, efforts: {} })).then((read) => {
    if (readingModels !== key) return;
    readingModels = null;
    models = { key, read };
    notify();
  });
}

type Target = { kind: 'repo'; key: string; name: string; path: string; repo: RepoView } | { kind: 'folder'; key: string; name: string; path: string; folder: FolderView };

const repoTarget = (repo: RepoView): Target => ({ kind: 'repo', key: `repo:${repo.id}`, name: repo.name, path: repo.path, repo });
const folderTarget = (folder: FolderView): Target => ({ kind: 'folder', key: `folder:${folder.path}`, name: folder.name, path: folder.path, folder });

const defaultBranch = (repo: RepoView) => (repo.base === 'HEAD' ? '' : repo.base.replace(/^origin\//, ''));

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => void subscribers.delete(fn);
};

// New task opens as a dialog over either view; a preset starts a new worktree of that repository with that prompt.
// The prompt's attachments are a draft of their own, kept as a reply box keeps its files.
const ATTACHED = 'new-task';

function clearAttached() {
  release(draftOf(ATTACHED));
  editDraft(ATTACHED, () => ({ text: '', files: [] }));
}

export function openNewTask(preset?: { repoId: number; name: string; prompt: string }) {
  const dialog = document.getElementById(DIALOG) as HTMLDialogElement | null;
  if (!dialog) return;
  if (preset) edit({ ...preset, folder: null, existing: false, branch: '', path: '' });
  if (!dialog.open) {
    opened++;
    edit({ ...(!preset && { name: '' }), start: 'now', at: '' });
    dialog.showModal();
  }
  dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
}

// Typing on the closed button opens the list with that letter already in the filter.
function RepoPicker({ repos, repo, pick }: { repos: Target[]; repo: Target; pick: (t: Target) => void }) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const seed = useRef('');
  const { home } = useStore();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const q = query.trim().toLowerCase();
  const shown = q ? repos.filter((r) => r.name.toLowerCase().includes(q) || tilde(r.path, home).toLowerCase().includes(q)) : repos;
  const at = Math.min(active, shown.length - 1);
  const activeId = shown[at] && `${id}-${at}`;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const choose = (r: Target) => {
    pick(r);
    list.current?.hidePopover();
  };

  const onToggle = (e: ToggleEvent<HTMLDivElement>) => {
    if (e.newState !== 'open') return;
    setQuery(seed.current);
    setActive(seed.current ? 0 : Math.max(0, repos.findIndex((r) => r.key === repo.key)));
    seed.current = '';
    filter.current?.focus();
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const letter = e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (!letter && e.key !== 'ArrowDown') return;
    e.preventDefault();
    if (letter) seed.current = e.key;
    list.current?.showPopover();
  };

  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) setActive((at + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (shown[at]) choose(shown[at]);
    } else if (e.key === 'Tab') {
      // Hiding hands focus back to the button, so Tab carries on from there and Shift+Tab stays on it.
      if (e.shiftKey) e.preventDefault();
      if (!e.shiftKey && shown[at]) choose(shown[at]);
      else list.current?.hidePopover();
    }
  };

  return (
    <>
      <button type="button" data-autofocus className={styles.repo} data-ux={repo.kind === 'folder' ? 'folder' : 'repository'} popoverTarget={`${id}-list`} aria-haspopup="listbox" aria-label={`${repo.kind === 'folder' ? 'Folder' : 'Repository'}: ${repo.name}`} onKeyDown={onButtonKey}>
        <span className={styles.caption}>{repo.kind === 'folder' ? 'Folder' : 'Repository'}</span>
        <strong>{repo.name}</strong>
        <Icon name="chevron-down" size={14} />
      </button>
      <div id={`${id}-list`} ref={list} popover="auto" className={styles.picker} onToggle={onToggle} data-repo-picker>
        <input
          ref={filter}
          className={styles.filter}
          role="combobox"
          aria-label="Filter repositories"
          aria-expanded
          aria-controls={`${id}-options`}
          aria-activedescendant={activeId}
          placeholder="Filter repositories"
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={onFilterKey}
          spellCheck={false}
          autoComplete="off"
        />
        <div id={`${id}-options`} role="listbox" aria-label="Repositories" className={styles.repos}>
          {shown.map((r, i) => (
            <button
              key={r.key}
              id={`${id}-${i}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={r.key === repo.key}
              data-active={i === at || undefined}
              data-folder={r.kind === 'folder' || undefined}
              data-ux={r.kind === 'folder' ? 'folder option' : 'repository option'}
              onPointerMove={() => setActive(i)}
              onClick={() => choose(r)}
            >
              <strong>{r.name}</strong>
              <code>{tilde(r.path, home)}</code>
              {r.kind === 'folder' && <span>{r.folder.repos.length} repositories · Claude picks which to change</span>}
            </button>
          ))}
          {shown.length === 0 && <p className={styles.none}>No repository matches “{query.trim()}”</p>}
        </div>
      </div>
    </>
  );
}

// The list opens on a click, a typed letter or ↓, and scrolls inside itself, so many branches never push the form away.
function BranchPicker({ branches, value, pick, where }: { branches: Branch[] | null; value: string; pick: (name: string) => void; where: (b: Branch) => string }) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = value.trim().toLowerCase();
  const all = branches ?? [];
  const exact = all.some((b) => b.name.toLowerCase() === q);
  const shown = q && !exact ? all.filter((b) => b.name.toLowerCase().includes(q)) : all;
  const at = Math.min(active, shown.length - 1);
  const activeId = open && shown[at] ? `${id}-${at}` : undefined;

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    if (open && !el.matches(':popover-open')) el.showPopover();
    if (!open && el.matches(':popover-open')) el.hidePopover();
  }, [open]);

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const show = () => {
    if (open) return;
    setActive(Math.max(0, shown.findIndex((b) => b.name.toLowerCase() === q)));
    setOpen(true);
  };

  const choose = (b: Branch) => {
    pick(b.name);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return show();
      if (shown.length) setActive((at + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && open) {
      e.preventDefault();
      if (shown[at]) choose(shown[at]);
    } else if (e.key === 'Escape' && open) {
      // Closes only the list, not the dialog around it.
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <>
      <label className={styles.field} data-branch-field>
        <span className={styles.caption}>Branch</span>
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={activeId}
          value={value}
          onChange={(e) => {
            pick(e.currentTarget.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={(e) => e.currentTarget.select()}
          onClick={show}
          onKeyDown={onKey}
          onBlur={() => setOpen(false)}
          placeholder="Pick or type to filter"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
        <div id={`${id}-list`} ref={list} popover="manual" role="listbox" aria-label="Branches" className={styles.branches} data-branch-picker>
          {shown.map((b, i) => (
            <button
              key={b.name}
              id={`${id}-${i}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={b.name.toLowerCase() === q}
              data-active={i === at || undefined}
              data-ux="branch option"
              onMouseDown={(e) => e.preventDefault()}
              onPointerMove={() => setActive(i)}
              onClick={() => choose(b)}
            >
              <code>{b.name}</code>
              {where(b) && <span>{where(b)}</span>}
            </button>
          ))}
          {shown.length === 0 && (
            <p className={styles.none}>{!branches ? 'Reading branches…' : all.length ? <>No branch matches “{value.trim()}”</> : 'No branches'}</p>
          )}
        </div>
    </>
  );
}

function NewTaskForm({ repos, done }: { repos: RepoView[]; done?: () => void }) {
  const f = useSyncExternalStore(subscribe, () => fields);
  const read = useSyncExternalStore(subscribe, () => branches);
  const opening = useSyncExternalStore(subscribe, () => opened);
  const known = useSyncExternalStore(subscribe, () => models);
  const attached = useDraft(ATTACHED);
  const promptField = useRef<HTMLTextAreaElement>(null);
  const { onPaste, onDragOver, onDrop } = takesFiles(ATTACHED, () => promptField.current?.focus());
  const { home, folders } = useStore();
  const targets = [
    ...folders.toSorted((a, b) => byName(a.name, b.name)).map(folderTarget),
    ...repos.toSorted((a, b) => byName(a.name, b.name)).map(repoTarget),
  ];
  const pickedFolder = folders.find((x) => x.path === f.folder);
  const repo = repos.find((r) => r.id === f.repoId) ?? repos[0];
  const target = pickedFolder ? folderTarget(pickedFolder) : repoTarget(repo);
  useEffect(() => {
    if (opening && !pickedFolder) readBranches(repo.id);
  }, [repo.id, opening, pickedFolder]);
  useEffect(() => {
    if (fields.existing && !fields.branch.trim()) edit({ branch: defaultBranch(repo) });
  }, [repo.id, opening]);
  useEffect(() => readModels(target.key, pickedFolder ? `/api/folders/models?path=${encodeURIComponent(pickedFolder.path)}` : `/api/repos/${repo.id}/models`), [target.key]);
  const existing = f.existing && !pickedFolder;

  const name = f.name.trim();
  const branch = f.branch.trim();
  const scheduling = f.start !== 'now';
  const when = whenOf(f);
  const valid = !uploading(attached) && (existing ? !!branch : pickedFolder ? NAME.test(name) && !name.includes('/') : NAME.test(name))
    && (!scheduling || (!!f.prompt.trim() && !!when && (existing || !name.includes('/'))));
  const main = repo.worktrees.find((w) => w.isMain);
  const list = read?.repoId === repo.id ? read.list : null;
  const picked = list?.find((b) => b.name === branch);
  const wanted = branch || name;
  const reused = list?.find((b) => b.name === wanted && (b.local || b.origin));

  const [error, create, pending] = useActionState(async () => {
    const now = fields;
    const files = readyPaths(draftOf(ATTACHED));
    const chose = {
      mode: pickedFolder ? 'folder' : now.existing ? 'existing-branch' : 'worktree', model: !!now.model, effort: !!now.effort,
      branch: !!now.branch.trim(), path: !!now.path.trim(), promptChars: now.prompt.trim().length, files: files.length,
    };
    try {
      if (now.start !== 'now') {
        const task = pickedFolder
          ? { kind: 'folder' as const, folder: pickedFolder.path, prompt: now.prompt, files, model: now.model, effort: now.effort }
          : { kind: 'repo' as const, repoId: repo.id, existingBranch: now.existing, branch: now.branch.trim(), path: untilde(now.path.trim(), home), prompt: now.prompt, files, model: now.model, effort: now.effort };
        const schedule = await api('POST', '/api/schedules', { name: now.existing && !pickedFolder ? '' : now.name.trim(), task, when: whenOf(now)! });
        edit({ ...EMPTY, ...choicesOf(now), repoId: pickedFolder ? now.repoId : repo.id, branch: now.existing && !pickedFolder ? defaultBranch(repo) : '' });
        clearAttached();
        track('new-task', { ...chose, schedule: now.start, ok: true });
        done?.();
        toast('info', `Scheduled ${schedule.name}: ${describeWhen(schedule.when)}. It is on the Wall.`);
        return null;
      }
      if (pickedFolder) {
        const result = await api('POST', '/api/folder-tasks', {
          folder: pickedFolder.path, name: now.name.trim(), prompt: now.prompt, files, model: now.model, effort: now.effort,
        });
        edit({ ...EMPTY, ...choicesOf(now) });
        clearAttached();
        track('new-task', { ...chose, ok: true });
        done?.();
        openSheet(result.sessionId);
        return null;
      }
      const result = await api('POST', '/api/worktrees', {
        repoId: repo.id,
        name: now.existing ? '' : now.name.trim(),
        branch: now.branch.trim(),
        path: untilde(now.path.trim(), home),
        prompt: now.prompt,
        files,
        existingBranch: now.existing,
        model: now.model,
        effort: now.effort,
      });
      edit({ ...EMPTY, ...choicesOf(now), repoId: repo.id, branch: now.existing ? defaultBranch(repo) : '' });
      clearAttached();
      track('new-task', { ...chose, ok: true });
      done?.();
      if (result.sessionId) openSheet(result.sessionId);
      return null;
    } catch (err) {
      track('new-task', { ...chose, ...(now.start !== 'now' && { schedule: now.start }), ok: false });
      return (err as Error).message;
    }
  }, null);

  const onFormKey = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const inPrompt = e.target instanceof HTMLTextAreaElement && !e.shiftKey && !e.altKey;
    if (inPrompt || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      if (valid && !pending) e.currentTarget.requestSubmit();
    }
  };

  const choices = known?.key === target.key ? known.read : null;
  const real = (value: string) => choices?.models[value] ?? null;
  const modelOptions = [
    ['', real('') ? modelName(real('')!) : 'Default'],
    ...['fable', 'opus', 'sonnet', 'haiku']
      .filter((a) => !real(a) || real(a)?.replace('[1m]', '') !== real('')?.replace('[1m]', ''))
      .map((a) => [a, real(a) ? modelName(real(a)!) : `${a[0].toUpperCase()}${a.slice(1)}`]),
  ];
  const usual = choices?.efforts[f.model] ?? null;
  const effortOptions = [['', usual ? effortName(usual) : 'Default'], ...Object.entries(EFFORTS).filter(([e]) => e !== usual)];
  const where = (b: Branch) => (!b.worktree ? '' : b.worktree === main?.path ? 'main checkout' : 'own worktree');
  const folder = repo.path.split('/').at(-1);

  const chosen = [when && describeWhen(when), f.model && modelOptions.find(([v]) => v === f.model)?.[1], f.effort && effortName(f.effort)].filter(Boolean).join(' · ');

  const modelControl = (
    <div className={styles.models}>
      <label className={styles.select} data-explain="The model Claude starts with; the first is the one your Claude Code settings pick">
        <span className={styles.caption}>Model</span>
        <select value={f.model} onChange={(e) => edit({ model: e.currentTarget.value })}>
          {modelOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <Icon name="chevron-down" size={14} />
      </label>
      <label className={styles.select} data-explain="How hard Claude thinks; the first is the one your Claude Code settings give that model">
        <span className={styles.caption}>Effort</span>
        <select value={f.effort} onChange={(e) => edit({ effort: e.currentTarget.value })}>
          {effortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <Icon name="chevron-down" size={14} />
      </label>
    </div>
  );

  const startControl = (
    <div className={styles.when} data-when>
      <fieldset className={styles.segments}>
        <legend>When Claude starts</legend>
        {(['now', 'once', 'repeat'] as const).map((start) => (
          <label key={start}>
            <input type="radio" name="start" checked={f.start === start} onChange={() => edit({ start, ...(start === 'once' && !f.at && { at: soon() }) })} />
            {{ now: 'Now', once: 'Once', repeat: 'Repeat' }[start]}
          </label>
        ))}
      </fieldset>
      {f.start === 'once' && (
        <label className={styles.select}>
          <span className={styles.caption}>At</span>
          <input type="datetime-local" aria-label="Start at" value={f.at} min={soon()} onChange={(e) => edit({ at: e.currentTarget.value })} />
        </label>
      )}
      {f.start === 'repeat' && (
        <>
          <label className={styles.select}>
            <span className={styles.caption}>At</span>
            <input type="time" aria-label="Start at" value={f.time} onChange={(e) => edit({ time: e.currentTarget.value })} />
          </label>
          <fieldset className={styles.segments} data-days>
            <legend>On</legend>
            {WEEK.map((d) => (
              <label key={d} data-explain={DAYS[d]}>
                <input
                  type="checkbox"
                  checked={f.days.includes(d)}
                  onChange={(e) => edit({ days: e.currentTarget.checked ? [...f.days, d] : f.days.filter((x) => x !== d) })}
                />
                {DAYS[d].slice(0, 2)}
              </label>
            ))}
          </fieldset>
        </>
      )}
    </div>
  );

  return (
    <form className={styles.form} action={create} onKeyDown={onFormKey} onPaste={onPaste} onDragOver={onDragOver} onDrop={onDrop}>
      <div className={styles.row}>
        <RepoPicker
          repos={targets}
          repo={target}
          pick={(t) => edit(t.kind === 'folder' ? { folder: t.path, branch: '' } : { folder: null, repoId: t.repo.id, branch: f.existing ? defaultBranch(t.repo) : '' })}
        />
        {!pickedFolder && (
          <fieldset className={styles.mode}>
            <legend>Where Claude runs</legend>
            <label><input type="radio" name="mode" checked={f.existing} onChange={() => edit({ existing: true, branch: defaultBranch(repo) })} />Current checkout</label>
            <label><input type="radio" name="mode" checked={!f.existing} onChange={() => edit({ existing: false, branch: '' })} />New worktree</label>
          </fieldset>
        )}
        {existing ? (
          <BranchPicker branches={list} value={f.branch} pick={(b) => edit({ branch: b })} where={where} />
        ) : (
          <label className={styles.field} data-explain={pickedFolder ? 'Names the task folder, and the branch of every worktree Claude opens' : 'Names the worktree folder, and the branch unless you set one'}>
            <span className={styles.caption}>Name</span>
            <input value={f.name} onChange={(e) => edit({ name: e.currentTarget.value.replace(/\s+/g, '-') })} placeholder="fix-login-redirect" spellCheck={false} autoComplete="off" />
          </label>
        )}
        <button type="submit" className={styles.create} disabled={!valid || pending}>
          {pending ? (scheduling ? 'Scheduling…' : 'Creating…') : scheduling ? 'Schedule' : 'Create'} <kbd>↵</kbd>
        </button>
      </div>
      <AttachedFiles id={ATTACHED} refocus={() => promptField.current?.focus()} />
      <div className={styles.promptRow} data-prompt>
        <textarea
          ref={promptField}
          className={styles.prompt}
          rows={1}
          aria-label="What should Claude work on?"
          placeholder="What should Claude work on?"
          value={f.prompt}
          onChange={(e) => edit({ prompt: e.currentTarget.value })}
        />
        <AttachButton id={ATTACHED} refocus={() => promptField.current?.focus()} />
      </div>
      <div className={styles.foot}>
        <p className={styles.hint} data-hint>
          {pickedFolder ? (
            <>
              Starts Claude in <code>{tilde(pickedFolder.path, home)}/worktrees/{name || '<name>'}</code>, where it reads{' '}
              {repos.filter((r) => pickedFolder.repos.includes(r.id)).map((r) => r.name).toSorted(byName).join(', ')} and opens a worktree on the
              branch <code>{name || '<name>'}</code> in each one it changes.
            </>
          ) : existing ? (
            picked?.worktree ? <>Starts Claude in <code>{tilde(picked.worktree, home)}</code>, where it is checked out.</>
              : <>Switches <code>{tilde(main?.path ?? repo.path, home)}</code> to {branch ? <code>{branch}</code> : 'the branch'} and starts Claude there.</>
          ) : (
            reused?.worktree ? <><code>{wanted}</code> is already checked out in <code>{tilde(reused.worktree, home)}</code>.</>
              : <>
                {reused?.local ? <>Reuses the local branch <code>{wanted}</code> and starts Claude there.</>
                  : reused ? <>Tracks <code>origin/{wanted}</code> in a new branch and starts Claude there.</>
                  : <>Branches from <code>{repo.base}</code> and starts Claude there.</>}
                {repo.setupCommand && <> Runs <code>{repo.setupCommand}</code> there first.</>}
              </>
          )}
        </p>
        <button type="button" className={styles.more} aria-expanded={f.more} data-more onClick={() => edit({ more: !f.more })}>
          More{!f.more && chosen && <span>{chosen}</span>}
          <Icon name={f.more ? 'chevron-down' : 'chevron-right'} size={14} />
        </button>
      </div>
      {f.more && (
        <div className={styles.extra} data-more-options>
          {!existing && !pickedFolder ? (
            <>
              <div className={styles.options}>
                <label className={styles.input} data-explain="The new branch; defaults to the name">
                  <span>Branch</span>
                  <input value={f.branch} onChange={(e) => edit({ branch: e.currentTarget.value.replace(/\s+/g, '-') })} placeholder={name || 'same as name'} spellCheck={false} />
                </label>
                <label className={styles.input} data-explain="Where the worktree is created; defaults to the repository's worktree folder">
                  <span>Worktree path</span>
                  <input value={f.path} onChange={(e) => edit({ path: e.currentTarget.value })} placeholder={`${tilde(repo.worktreeRoot ?? repo.defaultWorktreeRoot, home)}/${name || '<name>'}/${folder}`} spellCheck={false} />
                </label>
                {startControl}
              </div>
              <div className={styles.options}>{modelControl}</div>
            </>
          ) : (
            <div className={styles.options}>
              {startControl}
              {modelControl}
            </div>
          )}
          {scheduling && (
            <p className={styles.hint} data-when-hint>
              {!when ? (f.start === 'once' ? 'Pick a time to come.' : 'Pick at least one day.')
                : <>{existing ? 'Starts' : 'Creates the worktree and starts'} Claude {describeWhen(when)}{f.start === 'repeat' && !existing && <>, a new one each time, named <code>{name || '<name>'}-</code> and the date</>}. A run missed while the Mac sleeps starts when it wakes.</>}
            </p>
          )}
        </div>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  );
}

// Chrome lets Tab leave a modal dialog for its own toolbar, from where the repository button, first in the dialog, is
// hard to reach again; so Tab goes round inside it.
function wrapTab(e: KeyboardEvent<HTMLDialogElement>) {
  if (e.key !== 'Tab' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
    .filter((el) => el.tabIndex >= 0 && !el.matches(':disabled, [type="radio"]:not(:checked)') && el.checkVisibility());
  if (!stops.length || document.activeElement !== (e.shiftKey ? stops[0] : stops.at(-1))) return;
  e.preventDefault();
  (e.shiftKey ? stops.at(-1) : stops[0])!.focus();
}

export function NewTaskDialog({ repos }: { repos: RepoView[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <dialog id={DIALOG} ref={dialog} closedby="any" aria-label="New task" className={styles.dialog} onCancel={keepUnderLayer} onKeyDown={wrapTab}>
      {repos.length > 0 && <NewTaskForm repos={repos} done={() => dialog.current?.close()} />}
    </dialog>
  );
}
