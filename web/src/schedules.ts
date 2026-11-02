import { LATE_MS } from '../../server/schedule.ts';
import type { Scheduled, When } from './types.ts';
import { clock } from './util.ts';

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

// A moment to come in words: "today at 22:00", "tomorrow at 09:00", "Fri 6 Nov at 09:00".
export function day(at: number, now = Date.now()) {
  const d = new Date(at);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const date = sameDay(d, new Date(now)) ? 'today' : sameDay(d, tomorrow) ? 'tomorrow'
    : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${date} at ${clock(at)}`;
}

export function describeWhen(when: When, now = Date.now()) {
  if ('at' in when) return day(when.at, now);
  const days = when.days.toSorted((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const key = days.join();
  const on = key === '1,2,3,4,5,6,0' ? 'every day' : key === '1,2,3,4,5' ? 'weekdays' : key === '6,0' ? 'weekends'
    : days.length === 1 ? `${DAYS[days[0]]}s` : days.map((d) => DAYS[d].slice(0, 3)).join(', ');
  return `${on} at ${when.time}`;
}

// What a task started by a schedule says about it; a run that started late says why.
export function scheduledNote(s: Scheduled, now = Date.now()) {
  if (s.due === null) return `${s.name}, started with Run now ${day(s.at, now)}`;
  if (s.at - s.due > LATE_MS) return `${s.name}, due ${day(s.due, now)}; started ${day(s.at, now)}, as the Mac was asleep or Pitwall was not running then`;
  return `${s.name}, ${day(s.at, now)}`;
}
