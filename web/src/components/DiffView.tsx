import { parsePatchFiles, registerCustomTheme, type FileDiffMetadata } from '@pierre/diffs';
import type { ThemeRegistration } from 'shiki';
import { FileDiff, useWorkerPool, WorkerPoolContextProvider } from '@pierre/diffs/react';
import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { api } from '../api.ts';
import type { FullDiff } from '../types.ts';
import styles from './DiffView.module.css';
import { counts, fileAnchor, FileTree, inDir, matching, treeOrder } from './FileTree.tsx';
import { Icon } from './Icon.tsx';

registerCustomTheme('darcula', async () => (await import('../themes/darcula.json')).default as ThemeRegistration);

// The code keeps the user's Darcula; only the file headers take the board's greys around it.
const FILE_OPTIONS = {
  diffStyle: 'split', theme: 'darcula', themeType: 'dark', overflow: 'wrap', lineDiffType: 'word', stickyHeader: true,
  unsafeCSS: '[data-diffs-header][data-diffs-header] { background-color: #2f2f2f; border-bottom: 1px solid #383838; }',
} as const;

// Highlighting runs in workers, so a large diff never holds the page.
const POOL = {
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

// Typing in the filter or dragging the file list's edge renders the toolbar and the tree, not every file's diff again.
const FileDiffs = memo(function FileDiffs({ files, root, around }: { files: FileDiffMetadata[]; root: RefObject<HTMLDivElement | null>; around: string | null }) {
  const [drawn, setDrawn] = useState<ReadonlySet<string>>(() => new Set());
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
      {files.length === 1 || drawn.has(f.name) ? <FileDiff fileDiff={f} options={FILE_OPTIONS} /> : <div style={{ height: estimate(f) }} />}
    </section>
  ));
});

export function DiffView({ worktree }: { worktree: string }) {
  return (
    <WorkerPoolContextProvider {...POOL}>
      <Diffs worktree={worktree} />
    </WorkerPoolContextProvider>
  );
}

function Diffs({ worktree }: { worktree: string }) {
  const pool = useWorkerPool();
  const [diff, setDiff] = useState<(FullDiff & { files: FileDiffMetadata[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treeWidth, setTreeWidth] = useState(storedTreeWidth);
  const [loading, startLoading] = useTransition();
  const [selected, setSelected] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [whole, setWhole] = useState<FileDiffMetadata | null>(null);
  const [seeking, setSeeking] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const shownQuery = useDeferredValue(query);
  const diffsRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<string | null>(null);
  const opening = useRef<string | null>(null);

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
    const seek = () => {
      const line = diffsRef.current?.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line-type^="change-"]');
      if (!line && performance.now() - started < 2000) frame = requestAnimationFrame(seek);
      else {
        line?.scrollIntoView({ block: 'center' });
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
          <div className={styles.diffs} ref={diffsRef} data-seeking={seeking ?? undefined}>
            {diff && !files.length && <p className={styles.empty}>No changes against {diff.base}.</p>}
            {files.length > 0 && !listed.length && (
              <p className={styles.empty}>{shownQuery ? `No changed file${dir ? ` in ${dir}/` : ''} matches “${shownQuery.trim()}”.` : `No changes in ${dir}/ any more.`}</p>
            )}
            <FileDiffs files={shown} root={diffsRef} around={focused ? null : selected} />
          </div>
        </div>
      </div>
    </div>
  );
}
