import { useEffect, useState } from 'react';
import { useStore } from '../store.ts';
import type { Usage as Reading, UsageWindow } from '../types.ts';
import { clock } from '../util.ts';
import styles from './Usage.module.css';

const HOUR = 3_600_000;

const WINDOWS = [
  { key: 'fiveHour', label: '5h', name: '5-hour limit', weekday: false, length: 5 * HOUR },
  { key: 'sevenDay', label: '7d', name: 'Weekly limit', weekday: true, length: 7 * 24 * HOUR },
] as const;

// The reset as the top bar shows it: the time alone when it is today, with the weekday otherwise.
function resetLabel(at: number, now: number) {
  return clock(at, new Date(at).toDateString() !== new Date(now).toDateString());
}

const levelOf = (percent: number) => (percent >= 80 ? 'high' : percent >= 50 ? 'mid' : 'low');

// The share used up by now if the window were spent evenly until its reset: the part of the window gone.
function paceOf(resetsAt: number | null, length: number, now: number) {
  if (resetsAt === null || resetsAt <= now) return null;
  return Math.round(Math.min(Math.max(1 - (resetsAt - now) / length, 0), 1) * 100);
}

// The even pace moves with the clock, and a window whose reset time has passed starts again from nothing until the
// next reading says otherwise.
function useNow(usage: Reading | null) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [usage]);
  return now;
}

// The plan's 5-hour and weekly usage limits, as Claude Code's status line last read them.
export function Usage() {
  const { usage } = useStore();
  const now = useNow(usage);
  const read = usage ? clock(usage.at) : '';
  return (
    <div className={styles.usage} role="group" aria-label="Plan usage limits" data-usage>
      {WINDOWS.map((w) => {
        const win: UsageWindow | null | undefined = usage?.[w.key];
        if (!win) {
          const title = `${w.name}: no reading yet. Claude Code's status line writes it; see the README.`;
          return (
            <span key={w.key} className={styles.window} data-window={w.label} data-explain={title} aria-label={title}>
              <span className={styles.label}>{w.label}</span>
              <span className={styles.percent}>–</span>
            </span>
          );
        }
        const reset = win.resetsAt !== null && win.resetsAt <= now;
        const percent = reset ? 0 : Math.round(win.percent);
        const at = win.resetsAt && clock(win.resetsAt, w.weekday);
        const pace = paceOf(win.resetsAt, w.length, now);
        const versus = pace === null ? '' : percent === pace ? `, on an even pace` : `, ${Math.abs(percent - pace)} ${percent > pace ? 'over' : 'under'} an even pace of ${pace}%`;
        const title = reset
          ? `${w.name}: reset at ${at}, with no reading since`
          : `${w.name}: ${percent}% used${versus}${at ? ` · resets ${at}` : ''} · read at ${read}`;
        return (
          <span key={w.key} className={styles.window} data-window={w.label} data-level={levelOf(percent)} data-explain={title} aria-label={title}>
            <span className={styles.label}>{w.label}</span>
            <span className={styles.track} aria-hidden>
              <span className={styles.fill} style={{ width: `${Math.min(percent, 100)}%` }} />
              {pace !== null && <span className={styles.pace} data-pace={pace} style={{ left: `${pace}%` }} />}
            </span>
            <span className={styles.percent}>{percent}%</span>
            {!reset && win.resetsAt !== null && <span className={styles.reset} data-reset aria-hidden>↻ {resetLabel(win.resetsAt, now)}</span>}
          </span>
        );
      })}
    </div>
  );
}
