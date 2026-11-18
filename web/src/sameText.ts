// Where `picked` occurs in `line`, as [start, end) offsets. A picked name matches only whole names, so `id` is not found
// inside `width`; anything else matches as written.
export function occurrences(line: string, picked: string): [number, number][] {
  const escaped = picked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = /^[\w$]+$/.test(picked) ? new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g') : new RegExp(escaped, 'g');
  return [...line.matchAll(pattern)].map((m) => [m.index, m.index + picked.length]);
}

// Text worth marking elsewhere: on one line, not blank and not a whole screen of code.
export const markable = (text: string) => text.trim() !== '' && !text.includes('\n') && text.length <= 200;

// The text picked in a file's code is marked wherever else it occurs in that file, on both sides of the diff, until
// the selection goes. The code renders into each file's shadow root, so the selection is read from there.
export function markSameText(pane: HTMLElement) {
  const same = new Highlight();
  CSS.highlights.set('diff-same', same);
  let timer = 0;
  const mark = () => {
    same.clear();
    for (const host of pane.querySelectorAll('diffs-container')) {
      const root = host.shadowRoot;
      const selection = root?.getSelection?.();
      if (!root || !selection || selection.isCollapsed || !selection.anchorNode) continue;
      const picked = selection.toString();
      if (!markable(picked) || !selection.anchorNode.parentElement?.closest('[data-content] [data-line]')) return;
      for (const line of root.querySelectorAll('[data-content] [data-line]')) {
        const texts: Text[] = [];
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) texts.push(walker.currentNode as Text);
        const starts: number[] = [];
        let text = '';
        for (const t of texts) {
          starts.push(text.length);
          text += t.data;
        }
        const at = (offset: number, end: boolean) => {
          let i = starts.length - 1;
          while (i > 0 && (end ? starts[i] >= offset : starts[i] > offset)) i--;
          return [texts[i], offset - starts[i]] as const;
        };
        for (const [start, end] of occurrences(text, picked)) {
          const range = new Range();
          range.setStart(...at(start, false));
          range.setEnd(...at(end, true));
          same.add(range);
        }
      }
      return;
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = window.setTimeout(mark, 80);
  };
  document.addEventListener('selectionchange', later);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('selectionchange', later);
    CSS.highlights.delete('diff-same');
  };
}
