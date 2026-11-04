// One observer of the page's elements for every part of the board that follows them: elements coming and going, and
// dialogs and details opening or closing. Each watcher hears at most once a frame, with every change since; a hidden
// page, which draws no frames, hears a few times a second.
type Watcher = (records: readonly MutationRecord[]) => void;

const watchers = new Set<Watcher>();
let pending: MutationRecord[] = [];
let scheduled = false;

function run() {
  scheduled = false;
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  for (const fn of watchers) fn(batch);
}

const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver((records) => {
  pending.push(...records);
  if (scheduled) return;
  scheduled = true;
  const frame = requestAnimationFrame(run);
  setTimeout(() => {
    cancelAnimationFrame(frame);
    if (scheduled) run();
  }, 250);
});

// Needs document.body.
export function watchMutations(fn: Watcher) {
  if (!watchers.size) observer?.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
    if (watchers.size) return;
    observer?.disconnect();
    pending = [];
  };
}
