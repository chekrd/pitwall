import { uploadedImages } from '../../../server/uploadPaths.ts';
import { useLayoutEffect, useRef, useState } from 'react';
import { CopyButton } from './CopyButton.tsx';
import styles from './LatestReply.module.css';
import { Markdown } from './Markdown.tsx';
import { Pictures } from './Pictures.tsx';
import { useStore } from '../store.ts';

// What you wrote, cut to three lines until Show all, with the pictures sent along. Nothing when it is empty.
export function Said({ text, prompt = false }: { text: string; prompt?: boolean }) {
  const { home } = useStore();
  const asked = useRef<HTMLParagraphElement>(null);
  const { text: said, images } = uploadedImages(text, home);
  const [cut, setCut] = useState(false);
  const [full, setFull] = useState(false);
  useLayoutEffect(() => {
    const el = asked.current;
    setCut(!!el && el.scrollHeight > el.clientHeight);
  }, []);
  if (!said && !images.length) return null;
  return (
    <blockquote className={styles.prompt} data-prompt={prompt || undefined} data-full={full || undefined}>
      <span>You</span>
      {said && <p ref={asked}>{said}</p>}
      <Pictures srcs={images.map((i) => `/api/uploads/${i}`)} />
      {cut && <button type="button" className={styles.more} onClick={() => setFull(!full)}>{full ? 'Show less' : 'Show all'}</button>}
    </blockquote>
  );
}

// `previous` while a newer message of yours waits for its reply.
export function LatestReply({ text, prompt = null, previous = false }: { text: string; prompt?: string | null; previous?: boolean }) {
  return (
    <section className={styles.reply} data-ux-section="latest reply">
      <h3>{previous ? "Claude's previous reply" : "Claude's latest reply"}<CopyButton value={text} what="Reply" /></h3>
      <Said text={prompt ?? ''} prompt />
      <div className={styles.body}>
        <Markdown source={text} />
      </div>
    </section>
  );
}
