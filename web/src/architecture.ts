import type { ArchitectureChanges, LayoutedData } from './types.ts';

// LikeC4's colours for what the task adds and what it changes.
export const MARKS = { added: 'green', changed: 'amber' } as const;

type Mark = keyof typeof MARKS;

// The model as LikeC4 draws it, with the elements and relationships the task added drawn green and those it changed
// amber, in every diagram; an edge that stands for several relationships takes the mark of any of them, added first.
export function markChanges(data: LayoutedData, changes: ArchitectureChanges): LayoutedData {
  const elements = new Map<string, Mark>([...changes.elements.changed.map((e) => [e.id, 'changed'] as const), ...changes.elements.added.map((e) => [e.id, 'added'] as const)]);
  const relations = new Map<string, Mark>();
  for (const r of changes.relations.changed) if (r.relation) relations.set(r.relation, 'changed');
  for (const r of changes.relations.added) if (r.relation) relations.set(r.relation, 'added');
  const views = Object.fromEntries(Object.entries(data.views).map(([id, view]) => [id, {
    ...view,
    nodes: (view.nodes as { modelRef?: string | null }[]).map((n) => {
      const mark = n.modelRef ? elements.get(n.modelRef) : undefined;
      return mark ? { ...n, color: MARKS[mark] } : n;
    }),
    edges: (view.edges as { relations?: string[] }[]).map((e) => {
      const marks = (e.relations ?? []).map((r) => relations.get(r));
      const mark = marks.includes('added') ? 'added' : marks.includes('changed') ? 'changed' : null;
      return mark ? { ...e, color: MARKS[mark] } : e;
    }),
  }]));
  return { ...data, views };
}

export const changeCount = (c: ArchitectureChanges) =>
  c.elements.added.length + c.elements.removed.length + c.elements.changed.length + c.relations.added.length + c.relations.removed.length + c.relations.changed.length;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// "2 elements added, 1 changed; 3 relationships added, 1 removed".
export function describeChanges(c: ArchitectureChanges) {
  const part = (kind: { added: unknown[]; changed: unknown[]; removed: unknown[] }, one: string, many: string) => {
    const said = (['added', 'changed', 'removed'] as const).filter((k) => kind[k].length).map((k, i) => (i === 0 ? `${count(kind[k].length, one, many)} ${k}` : `${kind[k].length} ${k}`));
    return said.join(', ');
  };
  return [part(c.elements, 'element', 'elements'), part(c.relations, 'relationship', 'relationships')].filter(Boolean).join('; ') || 'no changes';
}

// The diagrams to pick from, in the model's order, with the overview LikeC4 calls index first.
export function diagramsOf(data: LayoutedData) {
  return Object.values(data.views).map((v) => ({ id: v.id, title: v.title || v.id, of: v.viewOf ?? null }))
    .toSorted((a, b) => Number(b.id === 'index') - Number(a.id === 'index'));
}
