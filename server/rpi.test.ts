import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOARD_HANDOFF, byCycle, firstOutdated, laterUnderWay, nextCycleDir, nextSteps, outdatedBy, outlineProgress, parseDocument, phaseLabel, pruneOutdated, reworkStep, rpiPrompt, stepMessage, stepsOf, summarize, taskDirName, withoutHandoff, type DocumentEntry, type Flow, type TaskFolder, type Workflow } from './rpi.ts';

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
  assert.deepEqual(parseDocument('05-structure-outline-retries.md', OUTLINE).progress, { done: 2, total: 3, unit: 'phase', started: true });
  assert.deepEqual(outlineProgress(['- [x] one', '- [ ] two', '* [X] three']), { done: 2, total: 3, unit: 'check', started: true }, 'no overview: every checkbox');
  assert.deepEqual(outlineProgress(['## Implementation Overview', '- [ ] Phase 1: a', '- [ ] Phase 2: b', '## Phase 1: a', '- [x] `pnpm test a`']),
    { done: 0, total: 2, unit: 'phase', started: true }, "a phase's own check ticked, its overview box open until the manual check");
  assert.deepEqual(outlineProgress(['## Implementation Overview', '- [ ] Phase 1: a', '## Phase 1: a', '- [ ] `pnpm test a`']), { done: 0, total: 1, unit: 'phase', started: false });
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

test('another cycle gets the lowest free -N from 2, whatever names an entry under the artifacts folder', () => {
  assert.equal(nextCycleDir('csv-export', []), 'csv-export-2');
  assert.equal(nextCycleDir('csv-export', ['csv-export']), 'csv-export-2');
  assert.equal(nextCycleDir('csv-export', ['csv-export', 'csv-export-2', 'csv-export-4', 'other-3']), 'csv-export-3');
  assert.equal(nextCycleDir('csv-export', ['csv-export-2', 'csv-export-3']), 'csv-export-4', 'an empty folder or a file of that name counts too');
});

test("Documents folds every folder but the workflow's under Earlier cycles, and nothing while there is one folder or the workflow's is not listed", () => {
  const f = (name: string) => ({ path: `.pitwall/artifacts/${name}` });
  const [first, second, third] = [f('x'), f('x-2'), f('x-3')];
  assert.deepEqual(byCycle([first, second, third], second.path), { current: [second], earlier: [first, third] });
  assert.deepEqual(byCycle([first], first.path), { current: [first], earlier: [] });
  assert.deepEqual(byCycle([first, second], '.pitwall/artifacts/gone'), { current: [first, second], earlier: [] });
  assert.deepEqual(byCycle([first, second], undefined), { current: [first, second], earlier: [] });
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
  assert.deepEqual(steps('research', 'tdd'), [`*Technical design: /rpi make a TDD ${dir}; flow: tdd`, `Outline: /rpi make an outline ${dir}; flow: tdd`, `Implement: /rpi implement ${dir}; flow: tdd`]);
  assert.deepEqual(steps('research', 'research-only'), [`*Implement: /rpi implement ${dir}; flow: research only`, `Outline: /rpi make an outline ${dir}; flow: research only`]);
  assert.deepEqual(steps('research', null), [
    `Design discussion: /rpi make a design discussion ${dir}; flow: design discussion`, `PRD: /rpi make a PRD ${dir}; flow: prd`,
    `Technical design: /rpi make a TDD ${dir}; flow: tdd`, `Implement: /rpi implement ${dir}; flow: research only`,
  ], 'with no flow named, each flow\'s first step');
  assert.deepEqual(steps('design-discussion', 'design-discussion'), [`*Outline: /rpi make an outline ${dir}`, `Implement: /rpi implement ${dir}`]);
  assert.deepEqual(steps('prd', 'prd'), [`*Technical design: /rpi make a TDD ${dir}; flow: prd`, `Outline: /rpi make an outline ${dir}`, `Implement: /rpi implement ${dir}`]);
  assert.deepEqual(steps('tdd', 'prd'), [`*Outline: /rpi make an outline ${dir}`, `Implement: /rpi implement ${dir}`], 'the TDD after a PRD');
  assert.deepEqual(steps('tdd', 'tdd'), [`*Outline: /rpi make an outline ${dir}`, `Implement: /rpi implement ${dir}`]);
  for (const flow of ['design-discussion', 'prd', 'tdd', 'research-only'] as const) {
    assert.deepEqual(steps('outline', flow), [`*Implement: /rpi implement ${dir}`], flow);
    assert.deepEqual(steps('implement', flow), [`*Implement the next phase: /rpi implement ${dir}`], flow);
    assert.deepEqual(steps('done', flow), [], `${flow}: every phase of the outline done`);
  }
  assert.equal(nextSteps(at('outline', 'tdd'), '/rpi:rpi')[0].command, `/rpi:rpi implement ${dir}`, 'in the invocation given');
});

test("every step starts a new conversation but the outline's next phase, which carries on the implementation under way", () => {
  for (const upTo of ['questions', 'research', 'prd', 'tdd', 'outline'] as const) {
    assert.ok(nextSteps(at(upTo, 'prd'), '/rpi').every((s) => s.fresh), upTo);
  }
  assert.deepEqual(nextSteps(at('implement', 'prd'), '/rpi').map((s) => s.fresh), [false]);
});

test('the note the board adds for rpi is left out as it is worded now and as it was first worded', () => {
  const first = 'Pitwall starts each next phase from its own buttons, in a new conversation: end with what to review and which phase comes next, without a command to run or a word about starting a new session.';
  assert.equal(withoutHandoff(`/rpi research x\n\n${first}`), '/rpi research x');
  assert.equal(withoutHandoff(`/rpi research x\n\n${BOARD_HANDOFF}`), '/rpi research x');
});

test('an implement step runs the implementer on Opus and a research step the research agents; other steps name no model', () => {
  const [implement] = nextSteps(at('outline', 'tdd'), '/rpi');
  const [research] = nextSteps(at('questions', 'tdd'), '/rpi');
  const [prd] = nextSteps(at('research', 'prd'), '/rpi');
  assert.equal(stepMessage(implement), `${implement.command}\nLaunch outline-implementer-agent with model: opus.\n\n${BOARD_HANDOFF}`);
  assert.equal(stepMessage(research),
    `${research.command}\nLaunch codebase-locator, codebase-analyzer, codebase-pattern-finder and web-search-researcher with model: opus.\n\n${BOARD_HANDOFF}`);
  assert.equal(stepMessage(prd), `${prd.command}\n\n${BOARD_HANDOFF}`);
});

const T = '.pitwall/artifacts/t';
const docAt = (name: string) => `${T}/${name}`;
// Research done, the design discussion done, the outline done with a phase of it implemented.
const underWay = (patch: Partial<Workflow> = {}): Workflow => ({
  folder: T, flow: 'design-discussion', current: 'implement', outline: { done: 1, total: 3, unit: 'phase', started: true }, documents: 4, folders: 1, stamp: 's',
  steps: [
    { phase: 'questions', state: 'done', document: docAt('01-research-questions-t.md') },
    { phase: 'research', state: 'done', document: docAt('02-research-t.md') },
    { phase: 'design-discussion', state: 'done', document: docAt('03-design-discussion-t.md') },
    { phase: 'outline', state: 'done', document: docAt('04-structure-outline-t.md') },
    { phase: 'implement', state: 'current', document: docAt('04-structure-outline-t.md') },
  ],
  versions: { [docAt('02-research-t.md')]: { latest: 2, settled: true }, [docAt('03-design-discussion-t.md')]: { latest: 3, settled: true }, [docAt('04-structure-outline-t.md')]: { latest: 1, settled: false } },
  ...patch,
});

test('the later phases under way of a document: each after it with a document, done or current, and Implement once a box of the outline is ticked', () => {
  assert.deepEqual(laterUnderWay(underWay(), docAt('02-research-t.md')), ['design-discussion', 'outline', 'implement']);
  assert.deepEqual(laterUnderWay(underWay(), docAt('04-structure-outline-t.md')), ['implement']);
  assert.deepEqual(laterUnderWay(underWay({ outline: { done: 0, total: 3, unit: 'phase', started: false } }), docAt('04-structure-outline-t.md')), [], 'no box of the outline ticked');
  assert.deepEqual(laterUnderWay(underWay({ outline: { done: 0, total: 3, unit: 'phase', started: true } }), docAt('04-structure-outline-t.md')), ['implement'], 'a check ticked, no phase done yet');
  assert.deepEqual(laterUnderWay(underWay(), docAt('99-notes.md')), [], 'not the document of a phase');
  const atDesign = underWay({
    current: 'design-discussion', outline: null,
    steps: underWay().steps.map((s) => (s.phase === 'design-discussion' ? { ...s, state: 'current' } : s.phase === 'outline' || s.phase === 'implement' ? { ...s, state: 'next', document: null } : s)),
  });
  assert.deepEqual(laterUnderWay(atDesign, docAt('02-research-t.md')), ['design-discussion'], 'the current one counts, the ones not yet do not');
});

test('the request stands before the research questions, which its phase stands for: a change to it outdates them and every later phase under way', () => {
  const REQUEST = docAt('00-request-t.md');
  assert.deepEqual(laterUnderWay(underWay({ request: REQUEST }), REQUEST), ['questions', 'research', 'design-discussion', 'outline', 'implement']);
  assert.deepEqual(laterUnderWay(underWay(), REQUEST), [], 'not the request');
  const marks = outdatedBy(underWay({ request: REQUEST }), REQUEST, 50);
  assert.deepEqual(marks.questions, { document: docAt('01-research-questions-t.md'), version: 1, because: REQUEST, at: 50, earlier: {} });
  assert.equal(firstOutdated(underWay(), marks), 'questions');
  const alone = stepsOf([REQ]);
  assert.equal(alone.request, alone.steps[0].document, 'with no research questions the request is the questions phase\'s own');
  assert.deepEqual(laterUnderWay(alone, alone.request!), []);
});

test('marking the later phases outdated keeps each document at its version now, the earlier ones marked with it, and Implement with none', () => {
  const marks = outdatedBy(underWay(), docAt('02-research-t.md'), 50);
  assert.deepEqual(marks, {
    'design-discussion': { document: docAt('03-design-discussion-t.md'), version: 3, because: docAt('02-research-t.md'), at: 50, earlier: {} },
    outline: { document: docAt('04-structure-outline-t.md'), version: 2, because: docAt('02-research-t.md'), at: 50, earlier: { [docAt('03-design-discussion-t.md')]: 3 } },
    implement: { document: null, version: null, because: docAt('02-research-t.md'), at: 50, earlier: { [docAt('03-design-discussion-t.md')]: 3, [docAt('04-structure-outline-t.md')]: 2 } },
  }, 'a document not settled yet is at the version it is becoming');
  assert.equal(firstOutdated(underWay(), marks), 'design-discussion');
  assert.equal(firstOutdated(underWay(), {}), null);
});

test("a document's mark goes once a newer version of it settles or a newer document takes the phase; Implement's stays; a phase gone takes its mark", () => {
  const marks = outdatedBy(underWay(), docAt('02-research-t.md'), 50);
  assert.deepEqual(Object.keys(pruneOutdated(marks, underWay())), ['design-discussion', 'outline', 'implement']);
  const writing = underWay({ versions: { ...underWay().versions, [docAt('03-design-discussion-t.md')]: { latest: 3, settled: false } } });
  assert.deepEqual(Object.keys(pruneOutdated(marks, writing)), ['design-discussion', 'outline', 'implement'], 'not while it is still being written');
  const settled = underWay({ versions: { ...underWay().versions, [docAt('03-design-discussion-t.md')]: { latest: 4, settled: true } } });
  assert.deepEqual(Object.keys(pruneOutdated(marks, settled)), ['outline', 'implement']);
  const replaced = underWay({ steps: underWay().steps.map((s) => (s.phase === 'outline' ? { ...s, document: docAt('05-structure-outline-t.md') } : s)) });
  assert.deepEqual(Object.keys(pruneOutdated(marks, replaced)), ['design-discussion', 'implement']);
  assert.deepEqual(Object.keys(pruneOutdated(marks, underWay({ steps: underWay().steps.filter((s) => s.phase !== 'implement') }))), ['design-discussion', 'outline']);
  assert.deepEqual(pruneOutdated(marks, underWay({ folder: `${T}-2` })), {}, "a new cycle's folder takes every mark of the one before, Implement's too");
});

test("a rework step updates the outdated document after a /clear, naming what changed and what was reworked since; Implement's fixes the code", () => {
  const marks = outdatedBy(underWay(), docAt('02-research-t.md'), 50);
  const design = reworkStep(underWay(), marks, 'design-discussion', '/rpi:rpi')!;
  assert.deepEqual({ ...design, command: '' }, { label: 'Rework Design discussion', command: '', usual: true, implements: false, researches: false, fresh: true, rework: 'design-discussion' });
  assert.equal(stepMessage(design), [
    `/rpi:rpi update ${docAt('03-design-discussion-t.md')}`,
    `\`${docAt('02-research-t.md')}\` changed after this document was written. Bring this document in line with the latest version of each and keep what still holds.`,
    '',
    BOARD_HANDOFF,
  ].join('\n'), 'no agent named');
  const research = reworkStep(underWay(), outdatedBy(underWay(), docAt('01-research-questions-t.md'), 50), 'research', '/rpi')!;
  assert.equal(stepMessage(research).split('\n').at(-3),
    'Launch codebase-locator, codebase-analyzer, codebase-pattern-finder and web-search-researcher with model: opus.', "Research's rework names the research agents' model");
  const reworked = underWay({ versions: { ...underWay().versions, [docAt('03-design-discussion-t.md')]: { latest: 4, settled: true }, [docAt('04-structure-outline-t.md')]: { latest: 2, settled: true } } });
  assert.equal(reworkStep(reworked, marks, 'outline', '/rpi')!.command.split('\n')[1],
    `\`${docAt('02-research-t.md')}\` changed after this document was written, and \`${docAt('03-design-discussion-t.md')}\` was reworked since to match it. Bring this document in line with the latest version of each and keep what still holds.`);
  const reworkedAll = underWay({ versions: { ...underWay().versions, [docAt('03-design-discussion-t.md')]: { latest: 4, settled: true }, [docAt('04-structure-outline-t.md')]: { latest: 3, settled: true } } });
  assert.equal(reworkStep(reworkedAll, marks, 'implement', '/rpi')!.command, [
    `/rpi fix the implementation ${T}`,
    `\`${docAt('02-research-t.md')}\` changed after the code was written, and \`${docAt('03-design-discussion-t.md')}\` and \`${docAt('04-structure-outline-t.md')}\` were reworked since to match it. Bring the code and its tests in line with the outline, \`${docAt('04-structure-outline-t.md')}\`, and keep what still holds.`,
  ].join('\n'));
  assert.equal(reworkStep(underWay(), {}, 'outline', '/rpi'), null, 'not outdated');
});
