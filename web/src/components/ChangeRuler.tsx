import type { FileDiffMetadata } from '@pierre/diffs';
import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject, type WheelEvent } from 'react';
import styles from './ChangeRuler.module.css';

type Run = { side: 'del' | 'add'; from: number; to: number };

// Split rows: a change block takes as many rows as its longer side, removed lines on the left, added on the right.
export function changeRuns(file: FileDiffMetadata): Run[] {
  const runs: Run[] = [];
  for (const hunk of file.hunks) {
    let row = hunk.splitLineStart;
    for (const part of hunk.hunkContent) {
      if (part.type === 'context') {
        row += part.lines;
        continue;
      }
      if (part.deletions) runs.push({ side: 'del', from: row, to: row + part.deletions });
      if (part.additions) runs.push({ side: 'add', from: row, to: row + part.additions });
      row += Math.max(part.deletions, part.additions);
    }
  }
  return runs;
}

type Layout = { track: number; scroll: number; view: number; top: number; codeTop: number; codeHeight: number };

// The file draws only the lines near the viewport, so the marks are placed from the diff's rows spread over the
// code's height rather than measured from lines that may not exist yet.
function measure(pane: HTMLElement, track: HTMLElement): Layout | null {
  const pre = pane.querySelector('diffs-container')?.shadowRoot?.querySelector('pre');
  if (!pre) return null;
  const box = pre.getBoundingClientRect();
  const codeTop = box.top - pane.getBoundingClientRect().top + pane.scrollTop;
  return { track: track.clientHeight, scroll: pane.scrollHeight, view: pane.clientHeight, top: pane.scrollTop, codeTop, codeHeight: box.height };
}

export function ChangeRuler({ file, pane }: { file: FileDiffMetadata; pane: RefObject<HTMLDivElement | null> }) {
  const runs = useMemo(() => changeRuns(file), [file]);
  const trackRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);

  useEffect(() => {
    const root = pane.current;
    const track = trackRef.current;
    if (!root || !track) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setLayout(measure(root, track)));
    };
    const resized = new ResizeObserver(update);
    resized.observe(root);
    resized.observe(track);
    for (const section of root.querySelectorAll('section[data-file]')) resized.observe(section);
    root.addEventListener('scroll', update, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      root.removeEventListener('scroll', update);
    };
  }, [file]);

  const scrollToTrack = (y: number, grip: number) => {
    const root = pane.current;
    if (!root || !layout) return;
    root.scrollTop = (y / layout.track) * layout.scroll - grip;
  };

  const press = (e: PointerEvent<HTMLDivElement>) => {
    if (!layout || e.button !== 0) return;
    const track = e.currentTarget;
    const at = (ev: { clientY: number }) => ev.clientY - track.getBoundingClientRect().top;
    const thumbTop = (layout.top / layout.scroll) * layout.track;
    const thumbHeight = (layout.view / layout.scroll) * layout.track;
    const y = at(e);
    const grip = y >= thumbTop && y <= thumbTop + thumbHeight ? ((y - thumbTop) / layout.track) * layout.scroll : layout.view / 2;
    scrollToTrack(y, grip);
    track.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => scrollToTrack(at(ev), grip);
    const end = () => {
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', end);
      track.removeEventListener('pointercancel', end);
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    e.preventDefault();
  };

  const wheel = (e: WheelEvent<HTMLDivElement>) => pane.current?.scrollBy({ top: e.deltaY });

  const rows = file.splitLineCount || 1;
  const px = (row: number) => (layout ? ((layout.codeTop + (row / rows) * layout.codeHeight) / layout.scroll) * layout.track : 0);

  return (
    <div ref={trackRef} className={styles.ruler} data-ruler onPointerDown={press} onWheel={wheel} data-explain="Where this file changed: removed lines on the left, added on the right. Click or drag to scroll there">
      {layout && (
        <>
          {runs.map((r) => (
            <span key={`${r.side}${r.from}`} className={styles.mark} data-side={r.side} style={{ top: px(r.from), height: Math.max(2, px(r.to) - px(r.from)) }} />
          ))}
          <span className={styles.thumb} style={{ top: (layout.top / layout.scroll) * layout.track, height: (layout.view / layout.scroll) * layout.track }} />
        </>
      )}
    </div>
  );
}
