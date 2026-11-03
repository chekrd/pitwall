import styles from './components/Tooltip.module.css';

const SHOW_MS = 350;
const GAP = 8;
const EDGE = 8;

let tip: HTMLDivElement | null = null;
let target: Element | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

const explained = (node: EventTarget | null) => (node instanceof Element ? node.closest('[data-explain]') : null);

function layer() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.id = 'tooltip';
  tip.className = styles.tooltip;
  tip.setAttribute('popover', 'hint');
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  return tip;
}

// Above the element, or below it when there is no room above, and kept inside the window.
function place(t: HTMLDivElement, at: DOMRect) {
  const { width, height } = t.getBoundingClientRect();
  const above = at.top - GAP - height >= EDGE;
  const top = above ? at.top - GAP - height : Math.min(at.bottom + GAP, innerHeight - height - EDGE);
  const left = Math.min(Math.max(at.left + at.width / 2 - width / 2, EDGE), innerWidth - width - EDGE);
  t.style.translate = `${Math.round(left)}px ${Math.round(Math.max(top, EDGE))}px`;
  t.dataset.side = above ? 'above' : 'below';
}

function show(el: Element) {
  const text = el.getAttribute('data-explain')?.trim();
  if (!text || !el.isConnected) return;
  const t = layer();
  t.textContent = text;
  if (!t.matches(':popover-open')) t.showPopover();
  place(t, el.getBoundingClientRect());
  if (!el.hasAttribute('aria-description')) el.setAttribute('aria-describedby', t.id);
}

function hide() {
  clearTimeout(timer);
  if (target?.getAttribute('aria-describedby') === 'tooltip') target.removeAttribute('aria-describedby');
  target = null;
  if (tip?.matches(':popover-open')) tip.hidePopover();
}

function aim(el: Element | null) {
  if (el === target) return;
  hide();
  if (!el) return;
  target = el;
  timer = setTimeout(() => show(el), SHOW_MS);
}

// One tooltip for every element with data-explain: on hover with a mouse or pen, and on keyboard focus. A touch shows
// none, as it has no hover; while it shows, the element is described by it for a screen reader.
export function installTooltips() {
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'touch') aim(explained(e.target));
  });
  document.addEventListener('pointerout', (e) => {
    if (target && !(e.relatedTarget instanceof Node && target.contains(e.relatedTarget))) hide();
  });
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof Element && e.target.matches(':focus-visible')) aim(explained(e.target));
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  // A tooltip still to come stays: it is placed when it shows, where the element is by then.
  document.addEventListener('scroll', () => {
    if (tip?.matches(':popover-open')) hide();
  }, true);
  // An Esc with a tooltip showing only dismisses it; the next does what Esc does there.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !target) return;
    const shown = !!tip?.matches(':popover-open');
    hide();
    if (!shown) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  addEventListener('resize', hide);
}
