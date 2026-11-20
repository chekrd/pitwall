import { parseDiffFromFile } from '@pierre/diffs';
import { FileDiff, WorkerPoolContextProvider } from '@pierre/diffs/react';
import { useEffect, useMemo, useState } from 'react';
import styles from './Changes.module.css';
import { POOL } from './DiffView.tsx';

const OPTIONS = {
  diffStyle: 'unified', theme: 'darcula', themeType: 'dark', overflow: 'wrap', lineDiffType: 'word', disableFileHeader: true,
} as const;

const INLINE = 4;

// The versions of one thing, newest first: a few side by side, more in a menu.
export function VersionPicker({ versions, shown, onPick, label = 'Version' }: { versions: number[]; shown: number; onPick: (n: number) => void; label?: string }) {
  if (versions.length < 2) return null;
  const newest = versions.toSorted((a, b) => b - a);
  if (newest.length > INLINE) {
    return (
      <label className={styles.menu} data-versions data-explain={`${newest.length} versions; v${newest[0]} is the latest`}>
        <span className={styles.hidden}>{label}</span>
        <select value={shown} onChange={(e) => onPick(Number(e.currentTarget.value))}>
          {newest.map((n, i) => <option key={n} value={n}>v{n}{i === 0 ? ' (latest)' : ''}</option>)}
        </select>
      </label>
    );
  }
  return (
    <span className={styles.versions} role="group" aria-label={`${label}s`} data-versions>
      {newest.map((n, i) => (
        <button key={n} type="button" data-version={n} aria-pressed={n === shown} data-explain={i === 0 ? `v${n}, the latest` : `Reads v${n}, as it was then`} onClick={() => onPick(n)}>
          v{n}
        </button>
      ))}
    </span>
  );
}

// A last line without its newline is no change worth showing.
const ended = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

export async function readText(url: string) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(r.statusText);
  return r.text();
}

// The texts at two URLs as a diff of their lines, the words changed in each line marked. `stamp` reads them again.
export function Changes({ before, after, name, from, to, stamp }: { before: string; after: string; name: string; from: number; to: number; stamp?: string | number | undefined }) {
  const [texts, setTexts] = useState<{ before: string; after: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([readText(before), readText(after)]).then(([b, a]) => {
      if (!live) return;
      setTexts({ before: b, after: a });
      setFailed(false);
    }, () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [before, after, stamp]);
  const diff = useMemo(() => texts && parseDiffFromFile({ name, contents: ended(texts.before) }, { name, contents: ended(texts.after) }), [texts, name]);
  return (
    <div className={styles.changes} data-theme="dark" data-changes={`${from}-${to}`}>
      <p className={styles.caption}>Changes from v{from} to v{to}</p>
      {failed && <p className={styles.note}>These versions could not be read.</p>}
      {!failed && texts && texts.before === texts.after && <p className={styles.note} data-no-changes>v{to} reads the same as v{from}.</p>}
      {!failed && diff && texts!.before !== texts!.after && (
        <WorkerPoolContextProvider {...POOL}>
          <FileDiff fileDiff={diff} options={OPTIONS} />
        </WorkerPoolContextProvider>
      )}
    </div>
  );
}
