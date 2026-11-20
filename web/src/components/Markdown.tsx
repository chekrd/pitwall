import { marked } from 'marked';
import type { BundledLanguage } from 'shiki';
import { useLayoutEffect, useRef } from 'react';
import { useStoreOf } from '../store.ts';
import { useDark } from '../theme.ts';
import { tildeIn } from '../util.ts';
import styles from './Markdown.module.css';

// Shiki's light-dark() colours follow the page's color-scheme, so the code changes with the board's theme. The spans are
// built here rather than from Shiki's HTML so the text never goes through innerHTML. setHTML drops marked's language-*
// class, so each block's language comes from its token, in document order.
async function highlight(root: HTMLElement, langs: string[], live: () => boolean) {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code')].map((code, i) => ({ code, lang: langs[i]?.split(/\s/)[0] }));
  if (!blocks.some((b) => b.lang)) return;
  const { codeToTokens } = await import('shiki');
  for (const { code, lang } of blocks) {
    if (!lang) continue;
    const tokens = await codeToTokens(code.textContent.replace(/\n$/, ''), {
      lang: lang as BundledLanguage, themes: { light: 'github-light-high-contrast', dark: 'github-dark' }, defaultColor: 'light-dark()',
    }).catch(() => null);
    if (!live()) return;
    if (!tokens) continue;
    code.replaceChildren(...tokens.tokens.flatMap((line, i) => [
      ...(i ? ['\n'] : []),
      ...line.map((t) => {
        const span = document.createElement('span');
        span.textContent = t.content;
        span.style.color = t.htmlStyle?.color ?? '';
        if (t.htmlStyle?.['font-style']) span.style.fontStyle = t.htmlStyle['font-style'];
        if (t.htmlStyle?.['font-weight']) span.style.fontWeight = t.htmlStyle['font-weight'];
        return span;
      }),
    ]));
  }
}

let diagrams = Promise.resolve();
let drawn = 0;

// A diagram becomes an SVG image, which can neither run anything nor load anything, sized by its own viewBox.
function svgImage(svg: string) {
  const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  if (el.nodeName !== 'svg') return null;
  const [, , w, h] = (el.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  if (w && h) {
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));
    el.style.removeProperty('max-width');
  }
  const img = document.createElement('img');
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(el))}`;
  img.alt = 'Diagram';
  img.dataset.diagram = '';
  return img;
}

// Mermaid loads only for a document that has a diagram. Its settings are global, so diagrams are drawn one at a time.
function draw(root: HTMLElement, langs: string[], dark: boolean, live: () => boolean) {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code')].filter((_, i) => langs[i]?.split(/\s/)[0] === 'mermaid');
  if (!blocks.length) return;
  diagrams = diagrams.then(async () => {
    if (!live()) return;
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', htmlLabels: false, fontFamily: 'system-ui, sans-serif' });
    for (const code of blocks) {
      const text = code.textContent;
      if (!live() || !(await mermaid.parse(text, { suppressErrors: true }))) continue;
      const out = await mermaid.render(`pitwall-diagram-${++drawn}`, text).catch(() => null);
      const img = out && svgImage(out.svg);
      if (live() && img) code.parentElement!.replaceWith(img);
    }
  }).catch(() => {});
}

let withPictures: Sanitizer | null = null;

// A document's own pictures and checkboxes, which the default sanitizer drops along with any picture from elsewhere.
const documentSanitizer = () => {
  if (!withPictures) {
    withPictures = new Sanitizer();
    withPictures.allowElement({ name: 'img', attributes: ['src', 'alt', 'title'] });
    withPictures.allowElement({ name: 'input', attributes: ['type', 'checked', 'disabled'] });
  }
  return withPictures;
};

// With `href`, a document's: its links and images are rewritten by it, an image it answers null for is left out, and
// its pictures, task lists and Mermaid diagrams show.
export function Markdown({ source, href }: { source: string; href?: (to: string, image: boolean) => string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const home = useStoreOf((s) => s.home);
  const hasDiagram = !!href && /^\s*(`{3,}|~{3,})\s*mermaid/m.test(source);
  const dark = useDark() && hasDiagram;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const langs: string[] = [];
    el.setHTML(marked.parse(tildeIn(source, home), {
      async: false,
      walkTokens: (t) => {
        if (t.type === 'code') langs.push(t.lang ?? '');
        if (href && (t.type === 'link' || t.type === 'image')) t.href = href(t.href, t.type === 'image') ?? '';
      },
    }), href ? { sanitizer: documentSanitizer() } : {});
    for (const img of el.querySelectorAll('img:not([src]), img[src=""]')) img.remove();
    let live = true;
    void highlight(el, hasDiagram ? langs.map((l) => (l.split(/\s/)[0] === 'mermaid' ? '' : l)) : langs, () => live);
    if (hasDiagram) draw(el, langs, dark, () => live);
    return () => { live = false; };
  }, [source, home, href, dark, hasDiagram]);
  return <div ref={ref} className={styles.markdown} />;
}
