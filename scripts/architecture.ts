import { resolve } from 'node:path';
import { ARCHITECTURE_DIR, layout, readModel } from '../server/architecture.ts';

// Checks a checkout's architecture model as the board lays it out, with LikeC4's Node API and nothing from the network:
// `node <pitwall>/scripts/architecture.ts check [checkout]`, the checkout being the current folder by default.

const [command, dir = '.'] = process.argv.slice(2);
if (command !== 'check') {
  console.error('usage: node scripts/architecture.ts check [checkout]');
  process.exit(2);
}
const root = resolve(dir);
const model = await readModel(root);
if (!model) {
  console.error(`${root} has no model: no .c4 files directly in ${ARCHITECTURE_DIR}`);
  process.exit(1);
}
const { data, errors } = await layout(model);
for (const e of errors) console.log(`${e.file}:${e.line}:${e.column} ${e.message}`);
if (!data) {
  console.log(`${errors.length} error${errors.length === 1 ? '' : 's'}: the board shows these instead of the diagrams`);
  process.exit(1);
}
const views = Object.values(data.views).map((v) => `${v.id}${v.viewOf ? ` (of ${v.viewOf})` : ''}`);
console.log(`ok: ${model.files.length} files, ${Object.keys(data.elements).length} elements, ${Object.keys(data.relations).length} relationships, views ${views.join(', ')}`);
