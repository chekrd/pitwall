import type { FileDiffMetadata } from '@pierre/diffs';
import { useEffect, useRef, useState, type PointerEvent, type RefObject, type WheelEvent } from 'react';
import styles from './ChangeRuler.module.css';

type Mark = { side: 'del' | 'add'; top: number; bottom: number };
type View = { track: number; scroll: number; height: number; top: number };

// Where the changed lines are in the pane's content, measured, since wrapped lines make rows uneven; touching lines join.
function measure(pane: HTMLElement): Mark[] {
  const lines = pane.querySelector('diffs-container')?.shadowRoot;
  if (!lines) return [];
  const origin = pane.getBoundingClientRect().top - pane.scrollTop;
  const marks: Mark[] = [];
  for (const [side, type] of [['del', 'change-deletion'], ['add', 'change-addition']] as const) {
    let run: Mark | null = null;
    for (const line of lines.querySelectorAll(`[data-line][data-line-type="${type}"]`)) {
      const box = line.getBoundingClientRect();
      const top = box.top - origin;
      const bottom = box.bottom - origin;
      if (run && top <= run.bottom + 1) run.bottom = Math.max(run.bottom, bottom);
      else marks.push((run = { side, top, bottom }));
    }
  }
  return marks;
}

export function ChangeRuler({ file, pane }: { file: FileDiffMetadata; pane: RefObject<HTMLDivElement | null> }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    const root = pane.current;
    const track = trackRef.current;
    if (!root || !track) return;
    let frame = 0;
    let remeasure = true;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (remeasure) setMarks(measure(root));
        remeasure = false;
        setView({ track: track.clientHeight, scroll: root.scrollHeight, height: root.clientHeight, top: root.scrollTop });
      });
    };
    const resized = new ResizeObserver(() => {
      remeasure = true;
      update();
    });
    resized.observe(root);
    resized.observe(track);
    for (const section of root.querySelectorAll('section[data-file]')) resized.observe(section);
    // A refresh can redraw the lines at the same height, which no resize reports.
    const redrawn = new MutationObserver(() => {
      remeasure = true;
      update();
    });
    let waiting = 0;
    const watch = () => {
      const lines = root.querySelector('diffs-container')?.shadowRoot;
      if (lines) redrawn.observe(lines, { childList: true, subtree: true });
      else waiting = requestAnimationFrame(watch);
    };
    watch();
    root.addEventListener('scroll', update, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(waiting);
      redrawn.disconnect();
      resized.disconnect();
      root.removeEventListener('scroll', update);
    };
  }, [file]);

  const press = (e: PointerEvent<HTMLDivElement>) => {
    const root = pane.current;
    if (!root || !view || e.button !== 0) return;
    const track = e.currentTarget;
    const scale = view.scroll / view.track;
    const at = (ev: { clientY: number }) => (ev.clientY - track.getBoundingClientRect().top) * scale;
    const y = at(e);
    const grip = y >= view.top && y <= view.top + view.height ? y - view.top : view.height / 2;
    const scrollTo = (ev: { clientY: number }) => {
      root.scrollTop = at(ev) - grip;
    };
    scrollTo(e);
    track.setPointerCapture(e.pointerId);
    const end = () => {
      track.removeEventListener('pointermove', scrollTo);
      track.removeEventListener('pointerup', end);
      track.removeEventListener('pointercancel', end);
    };
    track.addEventListener('pointermove', scrollTo);
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    e.preventDefault();
  };

  const wheel = (e: WheelEvent<HTMLDivElement>) => pane.current?.scrollBy({ top: e.deltaY });

  const px = (y: number) => (view ? (y / view.scroll) * view.track : 0);

  return (
    <div ref={trackRef} className={styles.ruler} data-ruler onPointerDown={press} onWheel={wheel} data-explain="Where this file changed: removed lines on the left, added on the right. Click or drag to scroll there">
      {view && (
        <>
          {marks.map((m) => (
            <span key={`${m.side}${m.top}`} className={styles.mark} data-side={m.side} style={{ top: px(m.top), height: Math.max(2, px(m.bottom) - px(m.top)) }} />
          ))}
          <span className={styles.thumb} style={{ top: px(view.top), height: px(view.height) }} />
        </>
      )}
    </div>
  );
}
