import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type PointerEvent } from 'react';
import { api } from '../api.ts';
import { EFFORTS, effortName, modelName } from '../util.ts';
import { Icon } from './Icon.tsx';
import styles from './ModelPicker.module.css';

// What each choice of model comes to, '' being what Claude Code picks by itself, and the effort it starts with.
interface Models {
  models: Record<string, string | null>;
  efforts: Record<string, string | null>;
}

export type ModelsUrl = `/api/repos/${number}/models` | `/api/folders/models?path=${string}`;

// Read once per target and kept, as both New task and Bug report pick for their own target at the same time.
let models: ReadonlyMap<string, Models> = new Map();
const reading = new Set<string>();
const subscribers = new Set<() => void>();

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => void subscribers.delete(fn);
};

// `key` is the target's: what a model resolves to depends on the settings of the folder Claude starts in.
function readModels(key: string, url: ModelsUrl) {
  if (reading.has(key) || models.has(key)) return;
  reading.add(key);
  void api('GET', url).catch(() => ({ models: {}, efforts: {} })).then((read) => {
    reading.delete(key);
    models = new Map(models).set(key, read);
    for (const fn of subscribers) fn();
  });
}

// `current` is what the first option stands for when it is not what Claude Code picks by itself, such as a running task's.
export interface Current {
  model: string | null;
  effort: string | null;
}

export function modelOptionsOf(choices: Models | null, current?: Current) {
  const real = (value: string) => choices?.models[value] ?? null;
  const first = current ? current.model : real('');
  return [
    ['', first ? modelName(first) : 'Default'],
    ...['fable', 'opus', 'sonnet', 'haiku']
      .filter((a) => (real(a) ?? a) !== first?.replace('[1m]', ''))
      .map((a) => [a, modelName(real(a) ?? a)]),
  ];
}

export interface Picked {
  model: string;
  effort: string;
}

function storedPick(key: string): Picked {
  try {
    const { model = '', effort = '' } = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<Picked>;
    return { model, effort };
  } catch {
    return { model: '', effort: '' };
  }
}

// A model and effort kept in this browser under `key`, as the next pick is usually the last one.
export function useStoredPick(key: string) {
  const [picked, setPicked] = useState(() => storedPick(key));
  const pick = (patch: Partial<Picked>) => {
    const next = { ...picked, ...patch };
    setPicked(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // A page without storage keeps them in memory only.
    }
  };
  return [picked, pick] as const;
}

export function useModelChoices(key: string, url: ModelsUrl | null) {
  const known = useSyncExternalStore(subscribe, () => models);
  useEffect(() => {
    if (url) readModels(key, url);
  }, [key]);
  return known.get(key) ?? null;
}

const TIPS = {
  model: "The model Claude starts with; the first is the one your Claude Code settings pick",
  effort: "How hard Claude thinks; the first is the one your Claude Code settings give that model",
};

export function ModelPicker({ choices, current, model, effort, onChange, tips = TIPS }: {
  choices: Models | null;
  current?: Current;
  model: string;
  effort: string;
  onChange: (patch: { model?: string; effort?: string }) => void;
  tips?: { model: string; effort: string };
}) {
  const modelOptions = modelOptionsOf(choices, current);
  const usual = current && !model ? current.effort : choices?.efforts[model] ?? null;
  const effortOptions = [['', usual ? effortName(usual) : 'Default'], ...Object.entries(EFFORTS).filter(([e]) => e !== usual)];

  // A click on a label only focuses its select; the options of an open list are inside the select and must pick as usual.
  // The press of a click outside an open list closes it, so the click that follows must not open it again.
  const listWasOpen = useRef(false);
  const noteList = (e: PointerEvent<HTMLLabelElement>) => {
    listWasOpen.current = !!e.currentTarget.querySelector('select:open');
  };
  const openList = (e: MouseEvent<HTMLLabelElement>) => {
    if ((e.target as Element).closest('select')) return;
    e.preventDefault();
    if (!listWasOpen.current) e.currentTarget.querySelector('select')?.showPicker();
  };

  return (
    <div className={styles.models}>
      <label className={styles.select} onPointerDownCapture={noteList} onClick={openList} data-explain={tips.model}>
        <span className={styles.caption}>Model</span>
        <select value={model} onChange={(e) => onChange({ model: e.currentTarget.value })}>
          {modelOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <Icon name="chevron-down" size={14} />
      </label>
      <label className={styles.select} onPointerDownCapture={noteList} onClick={openList} data-explain={tips.effort}>
        <span className={styles.caption}>Effort</span>
        <select value={effort} onChange={(e) => onChange({ effort: e.currentTarget.value })}>
          {effortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <Icon name="chevron-down" size={14} />
      </label>
    </div>
  );
}
