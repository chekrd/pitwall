import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArchitectureChanges, LayoutedData } from '../../server/architecture.ts';
import { changeCount, describeChanges, diagramsOf, markChanges } from './architecture.ts';

const data = {
  elements: {},
  relations: {},
  views: {
    api: { id: 'api', title: 'API components', viewOf: 'shop.api', nodes: [{ id: 'shop.api.orders', modelRef: 'shop.api.orders', color: 'primary' }, { id: 'shop.api.queue', modelRef: 'shop.api.queue', color: 'primary' }, { id: 'shop.db', modelRef: 'shop.db', color: 'primary' }], edges: [{ id: 'e1', relations: ['r1', 'r2'], color: 'gray' }, { id: 'e2', relations: ['r3'], color: 'gray' }] },
    index: { id: 'index', title: null, viewOf: null, nodes: [], edges: [] },
  },
} as unknown as LayoutedData;

const element = (id: string) => ({ id, title: id, kind: 'component' });
const relation = (key: string, id: string | null) => ({ key, relation: id, source: 'a', target: 'b', sourceTitle: 'A', targetTitle: 'B', title: key });
const changes: ArchitectureChanges = {
  elements: { added: [element('shop.api.queue')], changed: [element('shop.api.orders')], removed: [element('shop.legacy')] },
  relations: { added: [relation('k1', 'r2')], changed: [relation('k2', 'r1'), relation('k3', 'r3')], removed: [relation('k4', null)] },
};

test('the task\'s added elements and relationships are drawn green and its changed ones amber, an edge of several taking added first; the rest keep their colour', () => {
  const marked = markChanges(data, changes);
  assert.deepEqual((marked.views.api.nodes as { color: string }[]).map((n) => n.color), ['amber', 'green', 'primary']);
  assert.deepEqual((marked.views.api.edges as { color: string }[]).map((e) => e.color), ['green', 'amber']);
  assert.equal((data.views.api.nodes[0] as { color: string }).color, 'primary', 'the data the page read stays as it was');
});

test('the changes are counted and said in a line, and the diagrams listed with the overview first', () => {
  assert.equal(changeCount(changes), 7);
  assert.equal(describeChanges(changes), '1 element added, 1 changed, 1 removed; 1 relationship added, 2 changed, 1 removed');
  assert.equal(describeChanges({ ...changes, elements: { added: [], changed: [], removed: [] } }), '1 relationship added, 2 changed, 1 removed');
  assert.equal(describeChanges({ elements: { added: [], changed: [], removed: [] }, relations: { added: [], changed: [], removed: [] } }), 'no changes');
  assert.deepEqual(diagramsOf(data), [{ id: 'index', title: 'index', of: null }, { id: 'api', title: 'API components', of: 'shop.api' }]);
});
