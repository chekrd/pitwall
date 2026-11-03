import { uploadedImages } from '../../../server/uploadPaths.ts';
import { useLayoutEffect, useRef, useState } from 'react';
import { CopyButton } from './CopyButton.tsx';
import styles from './LatestReply.module.css';
import { Markdown } from './Markdown.tsx';
import { Pictures } from './Pictures.tsx';
import { useStore } from '../store.ts';

export function LatestReply({ text, prompt = null }: { text: string; prompt?: string | null }) {
  const { home } = useStore();
  const asked = useRef<HTMLParagraphElement>(null);
  const { text: said, images } = uploadedImages(prompt ?? '', home);
  const [cut, setCut] = useState(false);
  const [full, setFull] = useState(false);
  useLayoutEffect(() => {
    const el = asked.current;
    setCut(!!el && el.scrollHeight > el.clientHeight);
  }, []);
  return (
    <section className={styles.reply} data-ux-section="latest reply">
      <h3>Claude's latest reply<CopyButton value={text} what="Reply" /></h3>
      {(said || images.length > 0) && (
        <blockquote className={styles.prompt} data-prompt data-full={full || undefined}>
          <span>You</span>
          {said && <p ref={asked}>{said}</p>}
          <Pictures srcs={images.map((i) => `/api/uploads/${i}`)} />
          {cut && <button type="button" className={styles.more} onClick={() => setFull(!full)}>{full ? 'Show less' : 'Show all'}</button>}
        </blockquote>
      )}
      <div className={styles.body}>
        <Markdown source={text} />
      </div>
    </section>
  );
}
