// HumanLayer's rpi skill (plugin rpi@skills): the shape of the documents it writes into a task folder, and the
// workflow they trace. Nothing here touches the disk, so the page reads the same rules.

export const RPI_DIR = '.pitwall/artifacts';

export type DocType = 'request' | 'research-questions' | 'research' | 'design-discussion' | 'prd' | 'tdd' | 'outline';
export type Flow = 'design-discussion' | 'prd' | 'tdd' | 'research-only';
// `design` stands in for the design step while the flow is not known yet.
export type Phase = 'questions' | 'research' | 'design' | 'design-discussion' | 'prd' | 'tdd' | 'outline' | 'implement';
export type StepState = 'done' | 'current' | 'next' | 'skipped';

// The `type:` each template writes, and the other names the skill recognizes.
const DECLARED: Record<string, DocType> = {
  request: 'request',
  'research-questions': 'research-questions',
  research: 'research',
  'design-discussion': 'design-discussion',
  'design-prd': 'prd',
  prd: 'prd',
  'product-requirements': 'prd',
  'design-tdd': 'tdd',
  tdd: 'tdd',
  'tech-design': 'tdd',
  'structure-outline': 'outline',
  outline: 'outline',
};

// `NN-<type>-<description>.md`, longer names first so research-questions is not read as research.
const NAMED = Object.keys(DECLARED).toSorted((a, b) => b.length - a.length);

const PHASE_OF: Record<DocType, Phase> = {
  request: 'questions',
  'research-questions': 'questions',
  research: 'research',
  'design-discussion': 'design-discussion',
  prd: 'prd',
  tdd: 'tdd',
  outline: 'outline',
};

const ORDER: Phase[] = ['questions', 'research', 'design', 'design-discussion', 'prd', 'tdd', 'outline', 'implement'];

export const FLOWS: Record<Flow, Phase[]> = {
  'design-discussion': ['questions', 'research', 'design-discussion', 'outline', 'implement'],
  prd: ['questions', 'research', 'prd', 'tdd', 'outline', 'implement'],
  tdd: ['questions', 'research', 'tdd', 'outline', 'implement'],
  'research-only': ['questions', 'research', 'implement'],
};

export const PHASE_LABELS: Record<Phase, string> = {
  questions: 'Questions',
  research: 'Research',
  design: 'Design',
  'design-discussion': 'Design discussion',
  prd: 'PRD',
  tdd: 'Technical design',
  outline: 'Outline',
  implement: 'Implement',
};

export const TYPE_LABELS: Record<DocType, string> = {
  request: 'Request',
  'research-questions': 'Research questions',
  research: 'Research',
  'design-discussion': 'Design discussion',
  prd: 'PRD',
  tdd: 'Technical design',
  outline: 'Outline',
};

export interface Progress {
  done: number;
  total: number;
  // Phases of the outline's overview, or every checkbox when it has no overview.
  unit: 'phase' | 'check';
}

export interface DocumentMeta {
  type: DocType | null;
  title: string | null;
  // The NN- prefix.
  number: number | null;
  flow: Flow | null;
  progress: Progress | null;
}

const frontMatter = (text: string) => text.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);

function field(yaml: string, key: string) {
  const line = yaml.split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim().replace(/^(["'])(.*)\1$/, '$2').trim() || null;
}

function flowOf(value: string | null): Flow | null {
  const v = value?.toLowerCase().replaceAll('_', '-') ?? '';
  if (!v || v.includes('|') || v.startsWith('<')) return null;
  if (/research[ -]only/.test(v)) return 'research-only';
  if (/\bprd\b|product/.test(v)) return 'prd';
  if (/\btdd\b|tech/.test(v)) return 'tdd';
  if (/design/.test(v)) return 'design-discussion';
  return null;
}

function typeOfName(name: string): DocType | null {
  const rest = name.replace(/\.md$/i, '').replace(/^\d+-/, '').toLowerCase();
  const hit = NAMED.find((n) => rest === n || rest.startsWith(`${n}-`));
  return hit ? DECLARED[hit] : null;
}

// Lines outside fenced code blocks, so a `# comment` or `- [ ]` in an example does not count.
function prose(body: string) {
  let fence: string | null = null;
  return body.split(/\r?\n/).filter((line) => {
    const open = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (open && (!fence || open.startsWith(fence))) {
      fence = fence ? null : open;
      return false;
    }
    return !fence;
  });
}

const CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const DONE_MARK = '✅';

// The outline's progress: its Implementation Overview's phases, done when checked or marked ✅ there or on their own
// heading; without an overview, every checkbox.
export function outlineProgress(lines: string[]): Progress | null {
  const phaseOf = (text: string) => Number(text.match(/\bphase\s+(\d+)/i)?.[1] ?? 0);
  const doneHeadings = new Set(lines.map((l) => l.match(HEADING)?.[2] ?? '').filter((h) => h.includes(DONE_MARK)).map(phaseOf));
  const boxes = (from: string[]) => from.map((l) => l.match(CHECKBOX)).filter((m) => m !== null);
  const at = lines.findIndex((l) => HEADING.test(l) && /implementation overview/i.test(l));
  const after = lines.slice(at + 1);
  const end = after.findIndex((l) => HEADING.test(l));
  const overview = at < 0 ? [] : boxes(end < 0 ? after : after.slice(0, end));
  const items = overview.length ? overview : boxes(lines);
  if (!items.length) return null;
  const done = items.filter(([, mark, text]) => mark !== ' ' || text.includes(DONE_MARK) || (phaseOf(text) > 0 && doneHeadings.has(phaseOf(text)))).length;
  return { done, total: items.length, unit: overview.length ? 'phase' : 'check' };
}

export function parseDocument(name: string, text: string): DocumentMeta {
  const fm = frontMatter(text);
  const yaml = fm?.[1] ?? '';
  const declared = field(yaml, 'type')?.toLowerCase() ?? null;
  const type = (declared && DECLARED[declared]) || typeOfName(name);
  const lines = prose(fm ? text.slice(fm[0].length) : text);
  const heading = lines.map((l) => l.match(HEADING)).find(Boolean);
  const title = heading?.[2].replace(/[*_`]/g, '').trim() || null;
  const number = name.match(/^(\d+)-/)?.[1];
  return {
    type,
    title,
    number: number === undefined ? null : Number(number),
    flow: flowOf(field(yaml, 'flow')),
    progress: type === 'outline' ? outlineProgress(lines) : null,
  };
}

export interface DocumentEntry extends DocumentMeta {
  // From the task's own folder (its worktree, or its task folder across repos), as the documents' routes take it.
  path: string;
  name: string;
  modifiedAt: number;
  size: number;
}

export interface SupportingFile {
  path: string;
  name: string;
  kind: 'mockup' | 'image';
  modifiedAt: number;
  size: number;
}

export interface TaskFolder {
  path: string;
  name: string;
  documents: DocumentEntry[];
  files: SupportingFile[];
}

export interface WorkflowStep {
  phase: Phase;
  state: StepState;
  // The newest document of the phase; for implement, the outline.
  document: string | null;
}

// What the snapshot tells of a document's versions: its latest, and whether the file on disk still reads as it.
export interface VersionState {
  latest: number;
  settled: boolean;
}

// The version the file on disk is, or is about to become once it settles.
export const currentVersion = (v: VersionState | null | undefined) => (v ? (v.settled ? v.latest : v.latest + 1) : 1);

// What the snapshot carries for a task that has documents: enough for the Wall's chip and the phase strip. `stamp`
// changes whenever a file under the task's folders does, so an open Documents tab knows to read them again.
export interface Workflow {
  folder: string;
  flow: Flow | null;
  steps: WorkflowStep[];
  current: Phase | null;
  outline: Progress | null;
  documents: number;
  folders: number;
  stamp: string;
  // By each document's path; set by the pass that reads them, as versions live on disk.
  versions?: Record<string, VersionState>;
}

const RANK: Record<DocType, number> = { request: 0, 'research-questions': 1, research: 2, 'design-discussion': 3, prd: 3, tdd: 4, outline: 5 };

// Workflow order: by phase, then the documents' own numbers.
export const byWorkflow = (a: DocumentEntry, b: DocumentEntry) =>
  (a.type ? RANK[a.type] : 9) - (b.type ? RANK[b.type] : 9) || (a.number ?? 1e9) - (b.number ?? 1e9) || a.name.localeCompare(b.name);

const newest = (docs: DocumentEntry[]) => docs.toSorted((a, b) => (b.number ?? -1) - (a.number ?? -1) || b.modifiedAt - a.modifiedAt)[0];

function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export function stampOf(folders: TaskFolder[]) {
  return hash(folders.flatMap((f) => [...f.documents, ...f.files].map((d) => `${d.path}:${d.modifiedAt}:${d.size}`)).join('\n'));
}

// The phases of one task folder, from its documents alone: the furthest phase with a document is current, the ones
// before it done, or skipped when they have none; the outline's checklist tells how far implementation got.
export function stepsOf(docs: DocumentEntry[]): Pick<Workflow, 'flow' | 'steps' | 'current' | 'outline'> {
  const typed = docs.filter((d) => d.type);
  const has = (p: Phase) => typed.some((d) => PHASE_OF[d.type!] === p);
  const declared = newest(typed.filter((d) => d.flow))?.flow ?? null;
  const flow = declared ?? (has('prd') ? 'prd' : has('tdd') ? 'tdd' : has('design-discussion') ? 'design-discussion' : null);
  const base = flow ? FLOWS[flow] : ['questions', 'research', 'design', 'outline', 'implement'] satisfies Phase[];
  const phases = ORDER.filter((p) => base.includes(p) || (p !== 'implement' && p !== 'design' && has(p)));
  const outlineDoc = newest(typed.filter((d) => d.type === 'outline'));
  const outline = outlineDoc?.progress ?? null;
  const reached = (p: Phase) => (p === 'implement' ? !!outline && outline.done > 0 : has(p));
  const finished = !!outline && outline.total > 0 && outline.done === outline.total;
  const furthest = phases.findLastIndex(reached);
  const steps = phases.map((phase, i): WorkflowStep => {
    const own = phase === 'implement' ? outlineDoc : newest(typed.filter((d) => PHASE_OF[d.type!] === phase && d.type !== 'request'))
      ?? newest(typed.filter((d) => PHASE_OF[d.type!] === phase));
    const state: StepState = i < furthest ? (reached(phase) ? 'done' : 'skipped')
      : i === furthest ? (phase === 'implement' && finished ? 'done' : 'current') : 'next';
    return { phase, state, document: own?.path ?? null };
  });
  return { flow, steps, current: steps.find((s) => s.state === 'current')?.phase ?? null, outline };
}

// The task's workflow is the folder last written to; a task with no documents has none.
export function summarize(folders: TaskFolder[]): Workflow | null {
  const withDocs = folders.filter((f) => f.documents.length);
  if (!withDocs.length) return null;
  const latest = (f: TaskFolder) => Math.max(...f.documents.map((d) => d.modifiedAt), ...f.files.map((d) => d.modifiedAt));
  const folder = withDocs.toSorted((a, b) => latest(b) - latest(a))[0];
  return {
    folder: folder.path,
    ...stepsOf(folder.documents),
    documents: withDocs.reduce((n, f) => n + f.documents.length, 0),
    folders: withDocs.length,
    stamp: stampOf(folders),
  };
}

// What a Wall tile names: the phase under way, with the outline's progress while implementing.
export function phaseLabel(w: Pick<Workflow, 'current' | 'outline' | 'steps'>) {
  if (!w.current) return w.steps.length && w.steps.every((s) => s.state === 'done' || s.state === 'skipped') ? 'Done' : null;
  if (w.current === 'implement' && w.outline) return `${PHASE_LABELS.implement} ${w.outline.done}/${w.outline.total}`;
  return PHASE_LABELS[w.current];
}

// The folder New task gives rpi: the branch with / as -, or a slug of the name for a task without one.
export function taskDirName(branch: string | null | undefined, name: string) {
  const fromBranch = branch?.trim().replaceAll('/', '-');
  if (fromBranch) return fromBranch;
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'task';
}

// One message: Claude Code reads a slash command's arguments to the end of the message, and the task directory stays
// on the command's own line, as rpi's own next commands put it.
// rpi ends each phase by asking for its next command to be run in a new session; on the board a button does that.
export const BOARD_HANDOFF = 'Pitwall starts each next phase from its own buttons: end with what to review and which phase comes next, without a command to run or a word about starting a new session.';

// Earlier transcripts carry the line as it was first worded.
const FIRST_HANDOFF = 'Pitwall starts each next phase from its own buttons, in a new conversation: end with what to review and which phase comes next, without a command to run or a word about starting a new session.';

export const withoutHandoff = (text: string) => text.replace(FIRST_HANDOFF, '').replace(BOARD_HANDOFF, '').trim();

export function rpiPrompt(prompt: string, dir: string, invocation = '/rpi') {
  const [first = '', ...rest] = prompt.trim().split('\n');
  const head = first.trim() ? `${invocation} ${first.trim()}; task directory: ${dir}` : `${invocation} task directory: ${dir}`;
  return [head, ...rest, '', BOARD_HANDOFF].join('\n');
}

const FLOW_WORDS: Record<Flow, string> = { 'design-discussion': 'design discussion', prd: 'prd', tdd: 'tdd', 'research-only': 'research only' };

export interface NextStep {
  label: string;
  command: string;
  // The flow's usual next step, where rpi names one.
  usual: boolean;
  implements: boolean;
  // Sent after a /clear.
  fresh: boolean;
}

export const IMPLEMENTER_MODELS = ['opus', 'sonnet', 'fable'] as const;
export type ImplementerModel = (typeof IMPLEMENTER_MODELS)[number] | '';

// rpi's outline-implementer-agent inherits the conversation's model; '' leaves it at that.
export function stepMessage(step: NextStep, model: ImplementerModel) {
  const pick = step.implements && model ? [`Launch outline-implementer-agent with model: ${model}.`] : [];
  return [step.command, ...pick, '', BOARD_HANDOFF].join('\n');
}

// The steps rpi's workflow allows from the phase under way, each as the command rpi's own handoff gives for it. The
// research questions and the research carry the flow on; a design step's handoff names it only from a PRD to its TDD.
export function nextSteps(w: Pick<Workflow, 'folder' | 'flow' | 'current' | 'steps'>, invocation: string): NextStep[] {
  const step = (label: string, does: string, flow: Flow | null, usual = false): NextStep => ({
    label, usual, implements: does === 'implement', fresh: true, command: `${invocation} ${does} ${w.folder}${flow ? `; flow: ${FLOW_WORDS[flow]}` : ''}`,
  });
  const onward = (flow: Flow | null) => [step('Outline', 'make an outline', flow), step('Implement', 'implement', flow)];
  switch (w.current) {
    case 'questions':
      return [step('Research', 'research', w.flow, true)];
    case 'research':
      if (w.flow === 'design-discussion') return [step('Design discussion', 'make a design discussion', w.flow, true), ...onward(w.flow)];
      if (w.flow === 'prd') return [step('PRD', 'make a PRD', w.flow, true), ...onward(w.flow)];
      if (w.flow === 'tdd') return [step('Technical design', 'make a TDD', w.flow, true), ...onward(w.flow)];
      if (w.flow === 'research-only') return [{ ...step('Implement', 'implement', w.flow), usual: true }, step('Outline', 'make an outline', w.flow)];
      return [
        step('Design discussion', 'make a design discussion', 'design-discussion'), step('PRD', 'make a PRD', 'prd'), step('Technical design', 'make a TDD', 'tdd'),
        step('Implement', 'implement', 'research-only'),
      ];
    case 'prd':
      return [step('Technical design', 'make a TDD', 'prd', true), ...onward(null)];
    case 'design-discussion':
    case 'tdd':
      return [{ ...step('Outline', 'make an outline', null), usual: true }, step('Implement', 'implement', null)];
    case 'outline':
      return [step('Implement', 'implement', null, true)];
    case 'implement':
      return [{ ...step('Implement the next phase', 'implement', null, true), fresh: false }];
    default:
      return [];
  }
}

export const isDocument = (name: string) => /\.md$/i.test(name);

const IMAGES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

export function supportingKind(name: string): SupportingFile['kind'] | null {
  const ext = name.split('.').at(-1)?.toLowerCase() ?? '';
  return ext === 'html' || ext === 'htm' ? 'mockup' : ext in IMAGES ? 'image' : null;
}

export function contentType(name: string) {
  const ext = name.split('.').at(-1)?.toLowerCase() ?? '';
  if (ext === 'md') return 'text/markdown; charset=utf-8';
  if (ext === 'html' || ext === 'htm') return 'text/html; charset=utf-8';
  return IMAGES[ext] ?? null;
}
