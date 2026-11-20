import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOARD_HANDOFF, nextSteps, stepMessage, outlineProgress, parseDocument, phaseLabel, rpiPrompt, stepsOf, summarize, taskDirName, type DocumentEntry, type Flow, type TaskFolder } from './rpi.ts';

const doc = (name: string, text: string, modifiedAt = 1000): DocumentEntry =>
  ({ path: `.pitwall/artifacts/t/${name}`, name, modifiedAt, size: text.length, ...parseDocument(name, text) });

const fm = (type: string, extra = '') => `---\ntype: ${type}\nrepos:\n  - identifier: "acme/api"\n    sha: 0123abc\n${extra}---\n\n`;

test('a document is read by the type its front matter declares, else by its file name, with its first heading and number', () => {
  assert.deepEqual(parseDocument('01-research-questions-retries.md', `${fm('research-questions', 'flow: prd\n')}# Research Questions: Retries\n\n## Questions\n`), {
    type: 'research-questions', title: 'Research Questions: Retries', number: 1, flow: 'prd', progress: null,
  });
  assert.equal(parseDocument('03-prd-retries.md', `${fm('design-prd')}# Webhook retries`).type, 'prd');
  assert.equal(parseDocument('04-x.md', `${fm('"design-tdd"')}# T`).type, 'tdd', 'a quoted value');
  assert.equal(parseDocument('02-research-retries.md', '# Research: retries').type, 'research', 'no front matter');
  assert.equal(parseDocument('05-tech-design-retries.md', '# T').type, 'tdd');
  assert.equal(parseDocument('06-outline.md', '# O').type, 'outline');
  assert.equal(parseDocument('00-request-retries.md', '# Original Request: retries').type, 'request');
  assert.equal(parseDocument('notes.md', '# Notes').type, null);
  assert.equal(parseDocument('notes.md', '# Notes').number, null);
  assert.equal(parseDocument('01-x.md', `${fm('research-questions', 'flow: <design-discussion | prd | tdd | research-only>\n')}# Q`).flow, null, 'the template left unfilled');
  assert.equal(parseDocument('01-x.md', '```md\n# not this\n```\n\n# **The** `title`').title, 'The title', 'headings in code do not count');
});

const OUTLINE = `${fm('structure-outline')}# Outline: retries

## Implementation Overview

- [x] Phase 1: Failed deliveries are queued ✅
- [ ] Phase 2: The worker retries with backoff
- [ ] Phase 3: The dashboard shows attempts

## Phase 1: Failed deliveries are queued ✅

### Validation

- [x] \`pnpm test queue\` passes

## Phase 2: The worker retries with backoff ✅

- [ ] \`pnpm test worker\`

\`\`\`md
- [ ] not a checkbox
\`\`\`
`;

test("the outline's progress counts its overview's phases, done when checked or marked ✅ there or on the phase's heading", () => {
  assert.deepEqual(parseDocument('05-structure-outline-retries.md', OUTLINE).progress, { done: 2, total: 3, unit: 'phase' });
  assert.deepEqual(outlineProgress(['- [x] one', '- [ ] two', '* [X] three']), { done: 2, total: 3, unit: 'check' }, 'no overview: every checkbox');
  assert.equal(outlineProgress(['no boxes here']), null);
});

const Q = doc('01-research-questions-retries.md', `${fm('research-questions', 'flow: design-discussion\n')}# Q`);
const REQ = doc('00-request-retries.md', `${fm('request')}# Original Request: retries`);
const R = doc('02-research-retries.md', `${fm('research')}# Research`);
const D = doc('03-design-discussion-retries.md', `${fm('design-discussion')}# Design`);
const states = (docs: DocumentEntry[]) => stepsOf(docs).steps.map((s) => `${s.phase}:${s.state}`);

test('the furthest phase with a document is current, those before it done, and the flow the questions named sets the rest', () => {
  assert.deepEqual(states([REQ, Q]), ['questions:current', 'research:next', 'design-discussion:next', 'outline:next', 'implement:next']);
  assert.deepEqual(states([REQ, Q, R, D]), ['questions:done', 'research:done', 'design-discussion:current', 'outline:next', 'implement:next']);
  assert.equal(stepsOf([REQ, Q]).steps[0].document, Q.path, 'the questions, not the request');
});

test('every flow of rpi: PRD then TDD, TDD alone, research only, and an outline that is optional', () => {
  const q = (flow: string) => doc('01-research-questions-x.md', `${fm('research-questions', `flow: ${flow}\n`)}# Q`);
  assert.deepEqual(states([q('prd'), R]), ['questions:done', 'research:current', 'prd:next', 'tdd:next', 'outline:next', 'implement:next']);
  assert.deepEqual(states([q('tdd'), R]), ['questions:done', 'research:current', 'tdd:next', 'outline:next', 'implement:next']);
  assert.deepEqual(states([q('research-only'), R]), ['questions:done', 'research:current', 'implement:next']);
  const tdd = doc('04-tdd-x.md', `${fm('design-tdd')}# T`);
  const outline = doc('05-structure-outline-x.md', OUTLINE);
  assert.deepEqual(states([q('prd'), R, doc('03-prd-x.md', `${fm('design-prd')}# P`), tdd, outline]),
    ['questions:done', 'research:done', 'prd:done', 'tdd:done', 'outline:done', 'implement:current']);
  assert.deepEqual(states([q('research-only'), R, outline]), ['questions:done', 'research:done', 'outline:done', 'implement:current'], 'an outline after research alone');
  const started = doc('05-structure-outline-x.md', OUTLINE.replaceAll('[x]', '[ ]').replaceAll('✅', ''));
  assert.deepEqual(states([q('tdd'), R, tdd, started]), ['questions:done', 'research:done', 'tdd:done', 'outline:current', 'implement:next'], 'nothing implemented yet');
});

test('a step left out is skipped; with no flow named it is told by the design document, or stays Design', () => {
  assert.deepEqual(states([doc('01-tdd-x.md', `${fm('design-tdd')}# T`)]), ['questions:skipped', 'research:skipped', 'tdd:current', 'outline:next', 'implement:next']);
  assert.deepEqual(states([R]), ['questions:skipped', 'research:current', 'design:next', 'outline:next', 'implement:next']);
  assert.deepEqual(states([R, doc('04-structure-outline-x.md', OUTLINE)]), ['questions:skipped', 'research:done', 'design:skipped', 'outline:done', 'implement:current']);
});

test('all phases of the outline done: the workflow is done and nothing is current', () => {
  const done = doc('05-structure-outline-x.md', OUTLINE.replaceAll('[ ]', '[x]'));
  const w = stepsOf([Q, R, D, done]);
  assert.equal(w.current, null);
  assert.equal(w.steps.at(-1)!.state, 'done');
  assert.equal(phaseLabel(w), 'Done');
  assert.equal(phaseLabel(stepsOf([Q, R, D, doc('05-structure-outline-x.md', OUTLINE)])), 'Implement 2/3');
  assert.equal(phaseLabel(stepsOf([Q, R])), 'Research');
});

test('the summary is of the folder last written to, counts every document and changes its stamp with any file', () => {
  const folder = (name: string, docs: DocumentEntry[]): TaskFolder => ({ path: `.pitwall/artifacts/${name}`, name, documents: docs, files: [] });
  assert.equal(summarize([]), null);
  assert.equal(summarize([{ ...folder('a', []), files: [{ path: 'x.html', name: 'x.html', kind: 'mockup', modifiedAt: 1, size: 1 }] }]), null, 'a mockup alone is no workflow');
  const old = folder('old', [{ ...Q, modifiedAt: 10 }]);
  const now = folder('now', [{ ...Q, modifiedAt: 20 }, { ...R, modifiedAt: 30 }]);
  const w = summarize([old, now])!;
  assert.equal(w.folder, '.pitwall/artifacts/now');
  assert.equal(w.current, 'research');
  assert.deepEqual([w.documents, w.folders], [3, 2]);
  const touched = summarize([old, folder('now', [{ ...Q, modifiedAt: 20 }, { ...R, modifiedAt: 31 }])])!;
  assert.notEqual(touched.stamp, w.stamp);
});

test("New task's RPI prompt: one /rpi command with the task directory on its first line, the rest of the prompt after it, then that the board moves the phases", () => {
  assert.equal(rpiPrompt('Add retries to webhook delivery', '.pitwall/artifacts/webhook-retries'),
    '/rpi Add retries to webhook delivery; task directory: .pitwall/artifacts/webhook-retries' + `\n\n${BOARD_HANDOFF}`);
  assert.equal(rpiPrompt('  Add retries\n\nFailed ones are lost today.\n\n/Users/me/Library/Caches/pitwall/uploads/u1/log.txt  ', '.pitwall/artifacts/r'),
    '/rpi Add retries; task directory: .pitwall/artifacts/r\n\nFailed ones are lost today.\n\n/Users/me/Library/Caches/pitwall/uploads/u1/log.txt' + `\n\n${BOARD_HANDOFF}`);
  assert.equal(rpiPrompt('', '.pitwall/artifacts/r'), '/rpi task directory: .pitwall/artifacts/r' + `\n\n${BOARD_HANDOFF}`);
  assert.equal(rpiPrompt('Add retries', '.pitwall/artifacts/r', '/rpi:rpi'), '/rpi:rpi Add retries; task directory: .pitwall/artifacts/r' + `\n\n${BOARD_HANDOFF}`, 'the invocation the commands list');
  assert.equal(taskDirName('feature/webhook-retries', 'retries'), 'feature-webhook-retries');
  assert.equal(taskDirName('', 'Webhook Retries!'), 'webhook-retries');
  assert.equal(taskDirName(null, '***'), 'task');
});

// The documents of a task folder up to `upTo`, in the flow `flow` as the research questions name it.
function at(upTo: 'questions' | 'research' | 'design-discussion' | 'prd' | 'tdd' | 'outline' | 'implement' | 'done', flow: Flow | null) {
  const order = ['questions', 'research', 'design', 'outline', 'implement', 'done'];
  const design = upTo === 'design-discussion' || upTo === 'prd' || upTo === 'tdd' ? upTo : null;
  const reached = (p: string) => order.indexOf(p) <= order.indexOf(design ? 'design' : upTo);
  const docs = [doc('02-research-questions-x.md', `${fm('research-questions', flow ? `flow: ${flow}\n` : '')}# Q`)];
  if (reached('research')) docs.push(doc('03-research-x.md', `${fm('research')}# R`));
  if (design === 'tdd' && flow === 'prd') docs.push(doc('04-prd-x.md', `${fm('prd')}# P`));
  if (design) docs.push(doc(`05-${design}-x.md`, `${fm(design)}# D`));
  if (reached('outline')) {
    const box = (n: number) => (upTo === 'done' || (upTo === 'implement' && n === 1) ? 'x' : ' ');
    docs.push(doc('06-structure-outline-x.md', `${fm('structure-outline')}# O\n\n## Implementation Overview\n\n- [${box(1)}] Phase 1: a\n- [${box(2)}] Phase 2: b\n`));
  }
  return { folder: '.pitwall/artifacts/x', ...stepsOf(docs) };
}

const steps = (upTo: Parameters<typeof at>[0], flow: Flow | null) => nextSteps(at(upTo, flow), '/rpi').map((s) => `${s.usual ? '*' : ''}${s.label}: ${s.command}`);

test("the next steps rpi's workflow allows from each phase of each flow, as the commands its own handoffs give, the flow's usual one first", () => {
  const dir = '.pitwall/artifacts/x';
  for (const [flow, word] of [['design-discussion', 'design discussion'], ['prd', 'prd'], ['tdd', 'tdd'], ['research-only', 'research only']] as const) {
    assert.deepEqual(steps('questions', flow), [`*Research: /rpi research ${dir}; flow: ${word}`], flow);
  }
  assert.deepEqual(steps('questions', null), [`*Research: /rpi research ${dir}`], 'no flow named yet');
  assert.deepEqual(steps('research', 'design-discussion'), [
    `*Design discussion: /rpi make a design discussion ${dir}; flow: design discussion`,
    `Outline: /rpi make an outline ${dir}; flow: design discussion`,
    `Implement: /rpi implement ${dir}; flow: design discussion`,
  ]);
  assert.deepEqual(steps('research', 'prd'), [`*PRD: /rpi make a PRD ${dir}; flow: prd`, `Outline: /rpi make an outline ${dir}; flow: prd`, `Implement: /rpi implement ${dir}; flow: prd`]);
  assert.deepEqual(steps('research', 'tdd'), [`*TDD: /rpi make a TDD ${dir}; flow: tdd`, `Outline: /rpi make an outline ${dir}; flow: tdd`, `Implement: /rpi implement ${dir}; flow: tdd`]);
  assert.deepEqual(steps('research', 'research-only'), [`*Implement: /rpi implement ${dir}; flow: research only`, `Outline: /rpi make an outline ${dir}; flow: research only`]);
  assert.deepEqual(steps('research', null), [
    `Design discussion: /rpi make a design discussion ${dir}; flow: design discussion`, `PRD: /rpi make a PRD ${dir}; flow: prd`,
    `TDD: /rpi make a TDD ${dir}; flow: tdd`, `Implement: /rpi implement ${dir}; flow: research only`,
  ], 'with no flow named, each flow\'s first step');
  assert.deepEqual(steps('design-discussion', 'design-discussion'), [`*Outline: /rpi make an outline ${dir}`, `Implement: /rpi implement ${dir}`]);
  assert.deepEqual(steps('prd', 'prd'), [`*TDD: /rpi make a TDD ${dir}; flow: prd`, `Outline: /rpi make an outline ${dir}`, `Implement: /rpi implement ${dir}`]);
  assert.deepEqual(steps('tdd', 'prd'), [`*Outline: /rpi make an outline ${dir}`, `Implement: /rpi implement ${dir}`], 'the TDD after a PRD');
  assert.deepEqual(steps('tdd', 'tdd'), [`*Outline: /rpi make an outline ${dir}`, `Implement: /rpi implement ${dir}`]);
  for (const flow of ['design-discussion', 'prd', 'tdd', 'research-only'] as const) {
    assert.deepEqual(steps('outline', flow), [`*Implement: /rpi implement ${dir}`], flow);
    assert.deepEqual(steps('implement', flow), [`*Implement the next phase: /rpi implement ${dir}`], flow);
    assert.deepEqual(steps('done', flow), [], `${flow}: every phase of the outline done`);
  }
  assert.equal(nextSteps(at('outline', 'tdd'), '/rpi:rpi')[0].command, `/rpi:rpi implement ${dir}`, 'in the invocation given');
});

test('an implement step names the model for the implementer, and the conversation\'s model when none is picked; other steps name none', () => {
  const [implement] = nextSteps(at('outline', 'tdd'), '/rpi');
  const [research] = nextSteps(at('questions', 'tdd'), '/rpi');
  assert.equal(stepMessage(implement, 'opus'), `${implement.command}\nLaunch outline-implementer-agent with model: opus.\n\n${BOARD_HANDOFF}`);
  assert.equal(stepMessage(implement, ''), `${implement.command}\n\n${BOARD_HANDOFF}`);
  assert.equal(stepMessage(research, 'opus'), `${research.command}\n\n${BOARD_HANDOFF}`);
});
