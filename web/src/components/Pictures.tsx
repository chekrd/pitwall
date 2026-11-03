import { useState } from 'react';
import styles from './Pictures.module.css';

export function Pictures({ srcs }: { srcs: string[] }) {
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  if (!srcs.length) return null;
  return (
    <div className={styles.pictures}>
      {srcs.map((src, n) => gone.has(src) ? (
        <span key={src} className={styles.gone}>Picture #{n + 1} is no longer kept</span>
      ) : (
        <button key={src} type="button" aria-pressed={zoomed === src} data-explain={zoomed === src ? 'Smaller' : 'Larger'} onClick={() => setZoomed(zoomed === src ? null : src)}>
          <img src={src} alt={`Image #${n + 1}`} loading="lazy" onError={() => setGone((g) => new Set(g).add(src))} />
        </button>
      ))}
    </div>
  );
}
