import { parsePatchFiles, registerCustomTheme, type DiffLineAnnotation, type FileDiffMetadata, type SelectedLineRange } from '@pierre/diffs';
import type { ThemeRegistration } from 'shiki';
import { FileDiff, useWorkerPool, WorkerPoolContextProvider } from '@pierre/diffs/react';
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { api } from '../api.ts';
import { codeRef, parseSpot } from '../diffLines.ts';
import { markSameText } from '../sameText.ts';
import type { FullDiff, Session } from '../types.ts';
import { ChangeRuler } from './ChangeRuler.tsx';
import styles from './DiffView.module.css';
import { counts, fileAnchor, FileTree, inDir, matching, treeOrder } from './FileTree.tsx';
import { Icon } from './Icon.tsx';
import { LineNote } from './LineNote.tsx';
import { toast } from './Toasts.tsx';

registerCustomTheme('darcula', async () => (await import('../themes/darcula.json')).default as ThemeRegistration);

// The code keeps the user's Darcula; only the file headers take the board's greys around it.
const FILE_OPTIONS = {
  diffStyle: 'split', theme: 'darcula', themeType: 'dark', overflow: 'wrap', lineDiffType: 'word', stickyHeader: true, enableGutterUtility: true,
  unsafeCSS: '[data-diffs-header][data-diffs-header] { background-color: #2f2f2f; border-bottom: 1px solid #383838; } ::highlight(diff-same) { background-color: rgb(190 150 40 / 0.45); }',
} as const;

// Highlighting runs in workers, so a large diff never holds the page.
export const POOL = {
  poolOptions: { workerFactory: () => new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), { type: 'module' }), poolSize: 4 },
  highlighterOptions: { theme: 'darcula', lineDiffType: 'word' },
} as const;

// J and K step through the files of the diff on screen.
let stepper: ((by: 1 | -1) => void) | null = null;
// Esc steps back from one file to its folder or all files, and from a folder to all files, keeping the task open.
let widen: (() => void) | null = null;

export const stepFile = (by: 1 | -1) => stepper?.(by);
export const diffNarrowed = () => !!widen;
export const widenDiff = () => widen?.();

const TREE_WIDTH = 260;
const TREE_MIN = 140;
const TREE_MAX = 640;

const clampWidth = (w: number) => Math.round(Math.min(TREE_MAX, Math.max(TREE_MIN, w)));

function storedTreeWidth() {
  try {
    const w = Number(localStorage.getItem('diff-tree-width'));
    return w ? clampWidth(w) : TREE_WIDTH;
  } catch {
    return TREE_WIDTH;
  }
}

function storeTreeWidth(w: number) {
  try {
    localStorage.setItem('diff-tree-width', String(w));
  } catch {
    // per-viewer convenience only
  }
}

const NO_FILES: FileDiffMetadata[] = [];

// A file's height before it is drawn: its header, its lines side by side and the gaps between its hunks.
const estimate = (f: FileDiffMetadata) => 44 + f.splitLineCount * 18 + f.hunks.length * 32;

// A file is drawn once it comes this near the part of the diff in view, and then stays; the files from `around` on are
// drawn at once. Until then its section only takes its height, so a large diff does not build and highlight every
// file when it opens.
const NEAR_PX = 1500;
const AT_ONCE = 12;

// Lines picked with the gutter's + in one file, the draft about them written under the last one.
interface Picked {
  file: string;
  range: SelectedLineRange;
}

const NO_NOTES: DiffLineAnnotation[] = [];

// Where each task's diff was left, so coming back to its Diff tab opens there again: the file at the top of the view
// and how far into it, or the file opened whole and how far down it.
interface Place {
  file: string;
  offset: number;
  whole: boolean;
  dir: string | null;
}

const places = new Map<string, Place>();

// Typing in the filter or dragging the file list's edge renders the toolbar and the tree, not every file's diff again.
const FileDiffs = memo(function FileDiffs({ files, root, around, picked, marked, onPick, note }: {
  files: FileDiffMetadata[];
  root: RefObject<HTMLDivElement | null>;
  around: string | null;
  picked: Picked | null;
  marked: Picked | null;
  onPick: (file: string, range: SelectedLineRange) => void;
  note: ReactNode;
}) {
  const [drawn, setDrawn] = useState<ReadonlySet<string>>(() => new Set());
  // One options object per file for the life of the view, so picking lines in one does not draw the others again.
  const pick = useRef(onPick);
  pick.current = onPick;
  const options = useMemo(() => new Map<string, typeof FILE_OPTIONS & { onGutterUtilityClick: (r: SelectedLineRange) => void }>(), []);
  const optionsOf = (name: string) => {
    if (!options.has(name)) options.set(name, { ...FILE_OPTIONS, onGutterUtilityClick: (r) => pick.current(name, r) });
    return options.get(name)!;
  };
  const draw = (names: string[]) => setDrawn((was) => (names.every((n) => was.has(n)) ? was : new Set([...was, ...names])));

  // Before the paint, so a file scrolled to on the way back from it is there at once.
  useLayoutEffect(() => {
    const at = Math.max(0, files.findIndex((f) => f.name === around));
    draw(files.slice(Math.max(0, at - 2), at + AT_ONCE).map((f) => f.name));
  }, [files, around]);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      draw(entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset.file!));
    }, { root: root.current, rootMargin: `${NEAR_PX}px 0px` });
    for (const section of root.current?.querySelectorAll('section[data-file]') ?? []) observer.observe(section);
    return () => observer.disconnect();
  }, [files]);

  return files.map((f) => (
    <section key={f.name} id={fileAnchor(f.name)} data-file={f.name} className={styles.file} style={{ containIntrinsicSize: `auto ${estimate(f)}px` }}>
      {files.length === 1 || drawn.has(f.name) || marked?.file === f.name ? (
        <FileDiff
          fileDiff={f}
          options={optionsOf(f.name)}
          selectedLines={marked?.file === f.name ? marked.range : null}
          lineAnnotations={picked?.file === f.name ? [{ side: picked.range.side!, lineNumber: picked.range.end }] : NO_NOTES}
          renderAnnotation={() => note}
        />
      ) : <div style={{ height: estimate(f) }} />}
    </section>
  ));
});

// `at` is the place a draft was written about, from Later, which the file opens at with its lines marked.
export function DiffView({ session, at }: { session: Session; at: string | null }) {
  return (
    <WorkerPoolContextProvider {...POOL}>
      <Diffs key={session.id} session={session} at={at} />
    </WorkerPoolContextProvider>
  );
}

function Diffs({ session, at }: { session: Session; at: string | null }) {
  const worktree = session.worktree;
  const pool = useWorkerPool();
  const [diff, setDiff] = useState<(FullDiff & { files: FileDiffMetadata[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treeWidth, setTreeWidth] = useState(storedTreeWidth);
  const [loading, startLoading] = useTransition();
  const kept = useRef(at ? undefined : places.get(session.id));
  // The place being come back to, until it holds or the user scrolls: leaving meanwhile keeps it, as the files are not
  // all drawn yet and the diff is not where it reads.
  const restoring = useRef<Place | null>(null);
  const [selected, setSelected] = useState<string | null>(() => (kept.current && !kept.current.whole ? kept.current.file : null));
  const [focused, setFocused] = useState<string | null>(null);
  const [dir, setDir] = useState<string | null>(() => kept.current?.dir ?? null);
  const [whole, setWhole] = useState<FileDiffMetadata | null>(null);
  const [seeking, setSeeking] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const shownQuery = useDeferredValue(query);
  const diffsRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<string | null>(null);
  const opening = useRef<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [shownAt, setShownAt] = useState<Picked | null>(null);
  const seekLine = useRef<Picked | null>(null);
  const revealed = useRef<string | null>(null);
  const keptTop = useRef<number | null>(null);
  // A drag across both columns of the split view keeps the column it started in.
  const pick = useCallback((file: string, r: SelectedLineRange) => {
    setShownAt(null);
    setPicked({ file, range: { start: Math.min(r.start, r.end), end: Math.max(r.start, r.end), side: r.side ?? r.endSide ?? 'additions' } });
  }, []);

  const loadWhole = async (file: FileDiffMetadata) => {
    const paths = [file.name, ...(file.prevName ? [file.prevName] : [])].map((p) => `&path=${encodeURIComponent(p)}`).join('');
    const next = await api('GET', `/api/diff/file?worktree=${encodeURIComponent(worktree)}${paths}`);
    // Highlighted before it swaps in, so it never shows plain first; a fresh cache key keeps a refresh from showing the file as it was.
    const whole = parsePatchFiles(next.patch, { cacheKeyPrefix: crypto.randomUUID() }).flatMap((p) => p.files).find((f) => f.name === file.name) ?? null;
    if (whole) await pool?.primeDiffHighlightCache(whole).catch(() => {});
    return whole;
  };

  const load = () =>
    startLoading(async () => {
      try {
        const next = await api('GET', `/api/diff?worktree=${encodeURIComponent(worktree)}`);
        const files = treeOrder(parsePatchFiles(next.patch).flatMap((p) => p.files));
        const file = focused ? files.find((f) => f.name === focused) : undefined;
        const nextWhole = file ? await loadWhole(file) : null;
        startLoading(() => {
          setDiff({ ...next, files });
          setWhole(nextWhole);
          if (!file) setFocused(null);
          setError(null);
        });
      } catch (err) {
        setError((err as Error).message);
      }
    });

  useEffect(load, [worktree]);
  useEffect(() => markSameText(diffsRef.current!), []);

  // The file swaps in only once it is whole, so its hunks alone never flash first.
  const focus = (name: string) => {
    const file = files.find((f) => f.name === name);
    if (!file) return;
    setSelected(name);
    opening.current = name;
    startLoading(async () => {
      try {
        const next = await loadWhole(file);
        if (opening.current !== name) return;
        opening.current = null;
        startLoading(() => {
          if (!inDir(dir)(file)) setDir(null);
          if (!matching(query)(file)) setQuery('');
          setFocused(name);
          setWhole(next);
          setSeeking(name);
        });
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const leaveFile = () => {
    opening.current = null;
    seekLine.current = null;
    setShownAt(null);
    setSeeking(null);
    returnTo.current = focused;
    setFocused(null);
    setWhole(null);
  };

  const showAll = () => {
    leaveFile();
    setDir(null);
  };

  const filter = (next: string) => {
    if (focused) leaveFile();
    returnTo.current = null;
    setQuery(next);
  };

  const showDir = (path: string) => {
    leaveFile();
    returnTo.current = null;
    setDir(path);
    setSelected(null);
  };

  const back = () => (focused ? leaveFile() : setDir(null));

  // The diff renders into a shadow root after highlighting, so it stays hidden until its first changed line is in view.
  useEffect(() => {
    if (!seeking || whole?.name !== seeking) return;
    diffsRef.current?.scrollTo({ top: 0 });
    let frame = 0;
    const started = performance.now();
    const target = seekLine.current?.file === seeking ? seekLine.current.range : null;
    const top = keptTop.current;
    const seek = () => {
      const root = diffsRef.current?.querySelector('diffs-container')?.shadowRoot;
      const line = top !== null
        ? root?.querySelector('[data-line-type]')
        : target
          ? root?.querySelector(`[data-${target.side}] [data-column-number="${target.start}"]`)
          : root?.querySelector('[data-line-type^="change-"]');
      if (!line && performance.now() - started < 2000) frame = requestAnimationFrame(seek);
      else {
        if (top !== null) diffsRef.current?.scrollTo({ top });
        else line?.scrollIntoView({ block: 'center' });
        keptTop.current = null;
        seekLine.current = null;
        setSeeking(null);
      }
    };
    seek();
    return () => cancelAnimationFrame(frame);
  }, [whole, seeking]);

  useEffect(() => {
    if (!returnTo.current) diffsRef.current?.scrollTo({ top: 0 });
  }, [dir, shownQuery]);

  useEffect(() => {
    if (focused || !returnTo.current) return;
    document.getElementById(fileAnchor(returnTo.current))?.scrollIntoView();
    returnTo.current = null;
  }, [focused]);

  const resizeTo = (w: number) => {
    const next = clampWidth(w);
    setTreeWidth(next);
    storeTreeWidth(next);
  };

  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget;
    const left = handle.parentElement!.getBoundingClientRect().left;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => resizeTo(ev.clientX - left);
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const resizeByKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') resizeTo(treeWidth - step);
    else if (e.key === 'ArrowRight') resizeTo(treeWidth + step);
    else return;
    e.preventDefault();
  };

  const files = diff?.files ?? NO_FILES;
  const listed = useMemo(() => files.filter(inDir(dir)).filter(matching(shownQuery)), [files, dir, shownQuery]);
  const shown = useMemo(
    () => (focused ? [whole?.name === focused ? whole : files.find((f) => f.name === focused)].filter((f) => !!f) : listed),
    [focused, whole, files, listed],
  );
  const rulerFile = focused && whole?.name === focused ? whole : null;
  const pickedFile = picked && shown.find((f) => f.name === picked.file);
  const marked = pickedFile ? picked : shownAt;

  // Once, when the diff first came: a file no longer in it says so and the diff opens on all files.
  useEffect(() => {
    if (!diff || !at || revealed.current === at) return;
    revealed.current = at;
    const spot = parseSpot(at);
    if (!spot) return;
    if (!files.some((f) => f.name === spot.path)) {
      toast('info', `${spot.path} has no changes against ${diff.base} any more`);
      return;
    }
    const place = { file: spot.path, range: { start: spot.start, end: spot.end, side: spot.side === 'new' ? 'additions' : 'deletions' } } as const;
    seekLine.current = place;
    setShownAt(place);
    focus(spot.path);
  }, [diff, at]);

  // Before the paint, so the diff comes back at the place it was left and not at its top first.
  useLayoutEffect(() => {
    const place = kept.current;
    if (!diff || !place) return;
    kept.current = undefined;
    const file = files.find((f) => f.name === place.file);
    if (!file || (place.dir && !inDir(place.dir)(file))) {
      if (place.dir && !files.some(inDir(place.dir))) setDir(null);
      return;
    }
    if (place.whole) {
      keptTop.current = place.offset;
      focus(place.file);
      return;
    }
    const root = diffsRef.current;
    const section = document.getElementById(fileAnchor(place.file));
    if (!root || !section) return;
    // The files around it change height as they draw, and a drawn file has none until its highlighting comes back from
    // the workers, so the place is held until none of them is still drawing and it stops moving: hidden for two seconds, in sight after that on a busy
    // machine, and let go as soon as the user scrolls.
    setSeeking(place.file);
    restoring.current = place;
    let frame = 0;
    let still = 0;
    const started = performance.now();
    const cancel = () => {
      cancelAnimationFrame(frame);
      setSeeking(null);
      for (const type of ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const) root.removeEventListener(type, stop);
    };
    const stop = () => {
      restoring.current = null;
      cancel();
    };
    for (const type of ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const) root.addEventListener(type, stop, { passive: true });
    const hold = () => {
      if (!section.isConnected) return stop();
      const by = Math.round(section.getBoundingClientRect().top - root.getBoundingClientRect().top + place.offset);
      root.scrollTop += by;
      const drawing = [...root.querySelectorAll('diffs-container')].some((d) => !d.shadowRoot?.querySelector('pre'));
      still = by === 0 && !drawing && section.querySelector('diffs-container') ? still + 1 : 0;
      const held = performance.now() - started;
      if (held > 2000) setSeeking(null);
      if (still < 3 && held < 10_000) frame = requestAnimationFrame(hold);
      else stop();
    };
    hold();
    return cancel;
  }, [diff]);

  const leftAt = useRef<() => Place | null>(null);
  leftAt.current = () => {
    const root = diffsRef.current;
    if (!root) return null;
    if (focused) return { file: focused, offset: root.scrollTop, whole: true, dir };
    if (restoring.current) return restoring.current;
    const top = root.getBoundingClientRect().top;
    const section = [...root.querySelectorAll<HTMLElement>('section[data-file]')].find((s) => s.getBoundingClientRect().bottom > top);
    return section ? { file: section.dataset.file!, offset: top - section.getBoundingClientRect().top, whole: false, dir } : null;
  };
  // A layout cleanup runs while the diff is still in the page, so where it was scrolled can still be read.
  useLayoutEffect(() => () => {
    if (kept.current) return;
    const place = leftAt.current?.();
    if (place) places.set(session.id, place);
    else places.delete(session.id);
  }, []);

  const note = pickedFile ? <LineNote key={JSON.stringify(picked)} session={session} at={codeRef(pickedFile, picked.range)} onDone={() => setPicked(null)} /> : null;
  const dirStat = listed.map(counts).reduce((sum, c) => ({ add: sum.add + c.add, del: sum.del + c.del }), { add: 0, del: 0 });

  // From all files, J opens the file in view and K the one before it.
  useLayoutEffect(() => {
    stepper = (by) => {
      const order = listed.map((f) => f.name);
      const current = opening.current ?? focused;
      const from = order.indexOf(current ?? selected ?? order[0]);
      const to = current ? from + by : by === 1 ? from : from - 1;
      const name = order[Math.max(0, Math.min(order.length - 1, to))];
      if (name && name !== current) focus(name);
    };
    widen = focused || dir ? back : null;
    return () => {
      stepper = null;
      widen = null;
    };
  });

  useEffect(() => {
    const root = diffsRef.current;
    if (!root || focused) return;
    // A callback lists only the sections that crossed the band, so the ones still in it are kept to pick the top one from.
    const inBand = new Set<HTMLElement>();
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) inBand.add(e.target as HTMLElement);
        else inBand.delete(e.target as HTMLElement);
      }
      const top = [...inBand].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
      if (top) setSelected(top.dataset.file ?? null);
    }, { root, rootMargin: '0px 0px -85% 0px' });
    for (const section of root.querySelectorAll('section')) observer.observe(section);
    return () => observer.disconnect();
  }, [shown, focused]);

  return (
    <div className={styles.frame}>
      <div className={styles.view} data-theme="dark">
        <div className={styles.toolbar}>
          {focused && (
            <>
              <button type="button" className={styles.tool} data-explain="Esc" onClick={back}>← {dir ? `${dir}/` : 'All files'}</button>
              <code className={styles.path}>{focused}</code>
            </>
          )}
          {!focused && dir && (
            <>
              <button type="button" className={styles.tool} data-explain="Esc" onClick={back}>← All files</button>
              <code className={styles.path}>{dir}/</code>
              <span className={styles.stat}>
                <span>{listed.length} {listed.length === 1 ? 'file' : 'files'}{shownQuery && ' match'}</span> · <span className={styles.add}>+{dirStat.add}</span>{' '}
                <span className={styles.del}>−{dirStat.del}</span>
              </span>
            </>
          )}
          {diff && !focused && !dir && shownQuery && (
            <span className={styles.stat}>
              <span>{listed.length} of {files.length} files match</span> · <span className={styles.add}>+{dirStat.add}</span>{' '}
              <span className={styles.del}>−{dirStat.del}</span>
            </span>
          )}
          {diff && !focused && !dir && !shownQuery && (
            <span className={styles.stat}>
              <span>{diff.stat.files} files</span> · <span className={styles.add}>+{diff.stat.insertions}</span>{' '}
              <span className={styles.del}>−{diff.stat.deletions}</span> against{' '}
              <code>{diff.base}</code>
              {diff.mergeBase && <> @ <code data-explain="The commit where this branch left the base branch">{diff.mergeBase.slice(0, 8)}</code></>}
            </span>
          )}
          <span className={styles.hint} data-explain="The diff merges everything in the worktree, whether committed or not">{focused ? 'whole file' : 'committed + staged + unstaged + untracked'}</span>
          <button type="button" className={styles.tool} onClick={load} disabled={loading}>
            <Icon name="refresh" size={14} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.content} style={{ '--tree-width': `${treeWidth}px` } as CSSProperties}>
          {files.length > 0 && (
            <>
              <FileTree
                files={files}
                all={!focused && !dir}
                selected={focused ?? selected}
                dir={focused ? null : dir}
                onSelect={focus}
                onDir={showDir}
                onAll={showAll}
                query={query}
                onQuery={filter}
              />
              <div
                className={styles.resizer}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize the file list"
                aria-valuenow={treeWidth}
                aria-valuemin={TREE_MIN}
                aria-valuemax={TREE_MAX}
                tabIndex={0}
                data-explain="Drag to resize the file list; double-click to reset"
                onPointerDown={startResize}
                onKeyDown={resizeByKey}
                onDoubleClick={() => resizeTo(TREE_WIDTH)}
              />
            </>
          )}
          <div className={styles.pane}>
            <div className={styles.diffs} ref={diffsRef} data-seeking={seeking ?? undefined} data-ruled={rulerFile ? '' : undefined}>
              {diff && !files.length && <p className={styles.empty}>No changes against {diff.base}.</p>}
              {files.length > 0 && !listed.length && (
                <p className={styles.empty}>{shownQuery ? `No changed file${dir ? ` in ${dir}/` : ''} matches “${shownQuery.trim()}”.` : `No changes in ${dir}/ any more.`}</p>
              )}
              <FileDiffs files={shown} root={diffsRef} around={focused ? null : selected} picked={pickedFile ? picked : null} marked={marked} onPick={pick} note={note} />
            </div>
            {rulerFile && <ChangeRuler file={rulerFile} pane={diffsRef} />}
          </div>
        </div>
      </div>
    </div>
  );
}
