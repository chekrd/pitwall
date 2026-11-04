import { uploadedImages } from '../../../server/uploadPaths.ts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { showTab } from '../router.ts';
import { useStoreOf } from '../store.ts';
import type { Artifact, ConversationLog, Exchange as Turn, Session } from '../types.ts';
import { ago, clock, share } from '../util.ts';
import styles from './Conversation.module.css';
import { CopyButton } from './CopyButton.tsx';
import { Markdown } from './Markdown.tsx';
import { Pictures } from './Pictures.tsx';

// How far beyond the visible part of the log a reply is drawn as Markdown; further off it stays plain text until
// scrolled near, as parsing and highlighting every reply of a long transcript at once would hold the page.
const NEAR = '100% 0px';

// Read only while open: the whole transcript can run to many megabytes. A new reply or a /clear reads it again, and
// what did not change keeps its objects, so only the changed exchanges draw again. It opens on your last prompt, so its
// reply reads with the question in view.
export function Conversation({ session }: { session: Session }) {
  const [log, setLog] = useState<ConversationLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set());
  const scroll = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // How many times the opening scrolled to the last prompt, up to 3 once it stays.
  const opened = useRef(0);

  useEffect(() => {
    let live = true;
    api<ConversationLog[]>('GET', `/api/sessions/${session.id}/conversation`).then(
      (l) => live && (setLog((was) => share(was, l)), setError(null)),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [session.id, session.conversation, session.lastMessage]);

  const reach = (ids: string[]) => setNear((was) => (ids.every((id) => was.has(id)) ? was : new Set([...was, ...ids])));

  // Before the first paint the exchanges in view, and those within NEAR of it, are drawn whole, and the last prompt is
  // scrolled to again once they are, as drawing them changes their height.
  useLayoutEffect(() => {
    if (!log || opened.current > 2) return;
    opened.current++;
    [...box.current?.querySelectorAll('[data-prompt]') ?? []].at(-1)?.scrollIntoView({ block: 'start' });
    const view = scroll.current!.getBoundingClientRect();
    const ids = [...box.current!.querySelectorAll<HTMLElement>('[data-exchange]')].filter((a) => {
      const r = a.getBoundingClientRect();
      return r.bottom >= view.top - view.height && r.top <= view.bottom + view.height;
    }).map((a) => a.dataset.exchange!);
    if (ids.every((id) => near.has(id))) opened.current = 3;
    else reach(ids);
  }, [log, near]);

  useEffect(() => {
    if (!log) return;
    const observer = new IntersectionObserver((entries) => {
      reach(entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset.exchange!));
    }, { root: scroll.current, rootMargin: NEAR });
    for (const a of box.current?.querySelectorAll('[data-exchange]') ?? []) observer.observe(a);
    return () => observer.disconnect();
  }, [log]);

  if (!log) return <div className={styles.scroll}><p className={styles.note}>{error ?? 'Reading the conversation…'}</p></div>;
  const empty = log.every((c) => !c.exchanges.length);
  return (
    <div ref={scroll} className={styles.scroll}>
      <div ref={box} className={styles.log}>
        {error && <p className={styles.note}>{error}</p>}
        {empty && <p className={styles.note}>No prompts yet.</p>}
        {log.map((c, i) => (
          <section key={c.id} className={styles.conversation} data-conversation={c.id}>
            {i > 0 && <p className={styles.cleared}>/clear · a new conversation</p>}
            {c.exchanges.map((e) => (
              <Exchange key={e.id} session={session.id} conversation={c.id} exchange={e} artifacts={session.artifacts} whole={near.has(e.id)} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function Exchange({ session, conversation, exchange: e, artifacts, whole }: { session: string; conversation: string; exchange: Turn; artifacts: Artifact[]; whole: boolean }) {
  const made = e.artifacts.flatMap((id) => artifacts.find((a) => a.id === id) ?? []);
  return (
    <article className={styles.exchange} data-exchange={e.id}>
      <div className={styles.prompt} data-prompt>
        <h3>You <time data-explain={ago(e.at)}>{clock(e.at, true)}</time>{e.prompt && <CopyButton value={e.prompt} what="Prompt" />}</h3>
        <Prompt text={e.prompt} inline={Array.from({ length: e.images }, (_, n) => `/api/sessions/${session}/conversation/${conversation}/${e.id}/${n}`)} />
      </div>
      {e.reply ? (
        <div className={styles.reply} data-reply>
          <h3>Claude<CopyButton value={e.reply} what="Reply" /></h3>
          {whole ? <Markdown source={e.reply} /> : <div className={styles.plain}>{e.reply}</div>}
        </div>
      ) : <p className={styles.none} data-reply>No reply from Claude: still working, or stopped.</p>}
      {made.length > 0 && (
        <div className={styles.artifacts}>
          {made.map((a) => (
            <button key={a.id} type="button" data-ux="artifact" onClick={() => showTab('artifacts', a.id)}>
              <span>Artifact</span>
              <strong>{a.title}</strong>
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

function Prompt({ text, inline }: { text: string; inline: string[] }) {
  const { text: said, images } = uploadedImages(text, useStoreOf((s) => s.home));
  return (
    <>
      {said && <p>{said}</p>}
      <Pictures srcs={[...inline, ...images.map((i) => `/api/uploads/${i}`)]} />
    </>
  );
}
