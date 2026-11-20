import { useEffect, useRef } from 'react';
import { SHEET_DIALOG } from '../keys.ts';
import { showTab } from '../router.ts';
import type { Artifact, Session } from '../types.ts';
import { ago } from '../util.ts';
import styles from './Artifacts.module.css';
import { Changes, VersionPicker } from './Changes.tsx';
import { Icon } from './Icon.tsx';

export const artifactUrl = (sessionId: string, id: string) => `/api/sessions/${sessionId}/artifacts/${id}`;

export interface ArtifactGroup {
  title: string;
  // Oldest first.
  versions: Artifact[];
  latest: Artifact;
}

// One entry a title, its versions in the order they came; the one with the newest version first.
export function artifactGroups(list: readonly Artifact[]): ArtifactGroup[] {
  return [...Map.groupBy(list, (a) => a.title)]
    .map(([title, versions]) => {
      const sorted = versions.toSorted((a, b) => (a.version ?? 1) - (b.version ?? 1) || a.at - b.at);
      return { title, versions: sorted, latest: sorted.at(-1)! };
    })
    .toSorted((a, b) => b.latest.at - a.latest.at);
}

export const versionLabel = (g: ArtifactGroup) => (g.versions.length > 1 ? ` · v${g.latest.version}` : '');

export function Artifacts({ session, item, changes }: { session: Session; item: string | null; changes: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // Keys typed while the frame has focus go to its own document, out of reach of the board's keys, Esc among them, so
  // the task page takes focus back once the pointer is off the frame. The page gets no pointerleave for the
  // sandboxed frame, but it sees the pointer move over its own content again.
  useEffect(() => {
    const back = () => {
      const f = frame.current;
      if (f && document.activeElement === f) document.getElementById(SHEET_DIALOG)?.focus();
    };
    document.addEventListener('pointermove', back);
    return () => document.removeEventListener('pointermove', back);
  }, []);
  const groups = artifactGroups(session.artifacts);
  const group = groups.find((g) => g.versions.some((a) => a.id === item)) ?? groups[0];
  if (!group) return <p className={styles.empty}>Claude has not made any artifacts in this session.</p>;
  const shown = group.versions.find((a) => a.id === item) ?? group.latest;
  const previous = group.versions[group.versions.indexOf(shown) - 1];
  const showing = changes && previous;
  const pick = (n: number) => showTab('artifacts', group.versions.find((a) => a.version === n)?.id, { changes: showing ? true : undefined });
  return (
    <div className={styles.artifacts}>
      <div className={styles.list} role="tablist" aria-label="Artifacts" aria-orientation="vertical">
        {groups.map((g) => (
          <button key={g.title} type="button" role="tab" data-ux="artifact" data-artifact={g.title} aria-selected={g === group} onClick={() => showTab('artifacts', g.latest.id)}>
            <strong>{g.title}</strong>
            <span>made {ago(g.latest.at)}{versionLabel(g)}</span>
          </button>
        ))}
      </div>
      <div className={styles.viewer} role="tabpanel">
        <header>
          <strong>{group.title}</strong>
          <span>{group.versions.length > 1 && `v${shown.version} · `}made {ago(shown.at)}</span>
          <VersionPicker versions={group.versions.map((a) => a.version)} shown={shown.version} onPick={pick} />
          {previous && (
            <button
              type="button"
              className={styles.tool}
              aria-pressed={!!showing}
              data-show-changes
              data-explain={showing ? 'Shows the artifact itself again' : `Shows what its text says differently in v${shown.version} than in v${previous.version}`}
              onClick={() => showTab('artifacts', shown.id, { changes: showing ? undefined : true })}
            >
              Changes
            </button>
          )}
          <a href={artifactUrl(session.id, shown.id)} target="_blank" rel="noreferrer">
            Open in new tab <Icon name="external" size={14} />
          </a>
        </header>
        {showing
          ? <Changes key={`${previous.id}-${shown.id}`} before={`${artifactUrl(session.id, previous.id)}/text`} after={`${artifactUrl(session.id, shown.id)}/text`} name="artifact.txt" from={previous.version} to={shown.version} />
          : <iframe ref={frame} key={shown.id} className={styles.frame} data-explain={group.title} src={artifactUrl(session.id, shown.id)} sandbox="allow-scripts" />}
      </div>
    </div>
  );
}
