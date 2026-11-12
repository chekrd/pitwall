import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { ARTIFACT_TOOL, ASK_TOOL, MCP_SERVER_NAME, OPEN_WORKTREE_TOOL, ROUND_TOOL } from './config.ts';
import type { RoundRead } from './conversations.ts';
import { openWorktree } from './folderTasks.ts';
import type { Round } from './rounds.ts';

export const CATEGORIES = ['feature', 'bug', 'plan-problem', 'ci-failure', 'research', 'update', 'review-ready'] as const;

const inputSchema = {
  title: z.string().describe('One-line headline the user sees first, phrased as the question or the need.'),
  details: z.string().describe('Markdown with the context needed to decide: what you found, what you tried, trade-offs, your recommendation.'),
  options: z.array(z.object({
    label: z.string().describe('Short button label, e.g. "Keep the old API".'),
    description: z.string().optional(),
    recommended: z.boolean().optional().describe('Mark the option you recommend.'),
  })).optional().describe('Concrete choices, if the question has them. The user can always answer with free text instead.'),
  category: z.enum(CATEGORIES),
};

export const askInput = z.object(inputSchema);

const roundSchema = {
  title: z.string().optional().describe('A few words naming the round, e.g. "Round 2: where the data comes from".'),
  intro: z.string().optional().describe('Markdown that applies to the whole round: what the last answers settled, what you found out since. Leave out what belongs to one question.'),
  questions: z.array(z.object({
    title: z.string().describe('A short name for the question, e.g. "Where you use it".'),
    body: z.string().describe('Markdown: the question itself with what the user needs to answer it. It must stand on its own, as the user may read it without the others.'),
    options: z.array(z.object({
      label: z.string().describe('Short button text, e.g. "A web app on the phone".'),
      description: z.string().optional(),
    })).optional().describe('The concrete choices, when the question is one among a few. The user can always write an own answer instead.'),
    recommendation: z.string().optional().describe('Your recommended answer and why, in a sentence or two.'),
    recommended: z.string().optional().describe('The label of the option you recommend, copied exactly, when your recommendation is one of the options.'),
  })).min(1).describe('The questions, shown as Q1, Q2, … in this order.'),
};

export const roundInput = z.object(roundSchema);

const said = (text: string | undefined) => (text ?? '').trim();

// The round an ask_questions call posts, or null when the MCP server would have rejected its input.
export function roundOf(read: RoundRead): Round | null {
  if (read.source === 'prose') return { key: read.key, source: 'prose', title: '', intro: read.intro, questions: read.questions, at: read.at };
  const input = roundInput.safeParse(read.input);
  if (!input.success) return null;
  const questions = input.data.questions.map((q, i) => {
    const options = (q.options ?? []).map((o) => ({ label: o.label.trim(), description: said(o.description) || undefined })).filter((o) => o.label);
    return {
      id: `Q${i + 1}`, title: q.title.trim(), body: q.body.trim(), options, recommendation: said(q.recommendation),
      recommended: options.find((o) => o.label === said(q.recommended))?.label ?? null,
    };
  });
  return { key: read.key, source: 'tool', title: said(input.data.title), intro: said(input.data.intro), questions, at: read.at };
}

// A longer call would not fit the transcript lines the dashboard reads it from.
const MAX_ARTIFACT = 100_000;

const artifactSchema = {
  title: z.string().max(120).describe('Short name shown in the list, e.g. "Request flow before and after the fix". Calling again with the same title replaces that artifact.'),
  html: z.string().max(MAX_ARTIFACT).describe(
    `A complete, self-contained HTML document of at most ${MAX_ARTIFACT} characters: inline SVG, CSS and JS; no local files or fetches. ` +
    'It is shown in a sandboxed frame about 1000px wide; make it readable in both light and dark (prefers-color-scheme).',
  ),
};

export const artifactInput = z.object(artifactSchema);

// The dashboard reads calls to ask_human, ask_questions and create_artifact from the session transcript, so those tools
// only have to exist and acknowledge; open_worktree does its work here.
function server() {
  const mcp = new McpServer({ name: MCP_SERVER_NAME, version: '1.0.0' });
  mcp.registerTool(ASK_TOOL, {
    title: 'Ask the human',
    description:
      'The user supervises several Claude sessions from the Pitwall and does not watch every terminal. ' +
      'Call this to put a question or request on that dashboard when you genuinely need them: a problem with the plan or ' +
      'requirements you did not anticipate together, failures you cannot fix yourself (CI, tests, access, environment), ' +
      'a decision that is theirs to make (product behavior, trade-offs, scope, anything irreversible or outward-facing), ' +
      'or finished work ready for review. Do not use it for routine progress or for questions the code answers. ' +
      'Give context in `details`, offer concrete `options` and mark the one you recommend. ' +
      'After calling this, end your turn; the answer arrives as the next user message, usually starting with Re: "<title>".',
    inputSchema,
  }, async () => ({
    content: [{ type: 'text', text: 'Posted to the user\'s dashboard. End your turn now and wait; their answer will arrive as the next user message.' }],
  }));
  mcp.registerTool(ROUND_TOOL, {
    title: 'Ask the human several questions at once',
    description:
      `Call this instead of ${ASK_TOOL} when you have several separate questions for the user at once, such as a round of an ` +
      'interview about a plan or a design. The Pitwall shows each question on its own, with its options, your recommendation ' +
      'and a field for an own answer; the user answers them one by one, can talk a single question through with a copy of ' +
      'this conversation first, and sends all answers together. Put only questions in one call that can be answered ' +
      'independently of each other; one whose answer depends on another still open belongs to a later call. Give every ' +
      'question your recommended answer. After calling this, say in one line that the questions are posted, without ' +
      'repeating them, and end your turn. The answers arrive as the next user message, each named by its number (Q1, Q2, … ' +
      'in the order you gave them). "Your recommendation" as an answer takes your recommendation as it stood. A question ' +
      'the user left unanswered is said to be still open: ask it again in your next call, unless the other answers settled it.',
    inputSchema: roundSchema,
  }, async ({ questions }) => ({
    content: [{ type: 'text', text: `Posted to the user's dashboard as Q1${questions.length > 1 ? `–Q${questions.length}` : ''}. End your turn now and wait; the answers will arrive together as the next user message.` }],
  }));
  mcp.registerTool(ARTIFACT_TOOL, {
    title: 'Create a visual explanation',
    description:
      'The user follows this session from the Pitwall, which shows artifacts on the task page next to your messages. ' +
      'Call this when a picture would make something markedly easier to understand than prose: how data or control flows ' +
      'through the code, a before/after of a change, a state machine, a timeline of events behind a bug, a dependency or ' +
      'architecture map, a comparison of options, numbers worth charting. Draw the real mechanism with real names from the ' +
      'code, label it, and keep it to one idea. Skip it for things a few sentences explain. Mention in your reply that you ' +
      'made it; the user cannot see it in the terminal.',
    inputSchema: artifactSchema,
  }, async ({ title }) => ({
    content: [{ type: 'text', text: `Artifact "${title}" is on the task page of the user's dashboard.` }],
  }));
  mcp.registerTool(OPEN_WORKTREE_TOOL, {
    title: 'Open a worktree for this task',
    description:
      'Only for a Pitwall task that spans several repositories, whose working directory is a task folder ' +
      '<folder>/worktrees/<task> beside the repositories\' main checkouts. Call it before you change anything in one of ' +
      'those repositories: it creates the worktree <task folder>/<repository> on the branch named after the task, or returns ' +
      'the one that exists, and you make that repository\'s changes only there. Open worktrees only in the repositories the ' +
      'task needs to change.',
    inputSchema: {
      repo: z.string().describe('The repository\'s folder name, e.g. "api".'),
      task_folder: z.string().describe('Your working directory, the task folder.'),
    },
  }, async (input) => {
    try {
      const w = await openWorktree(input);
      const setup = w.setup ? `\nRun its setup command there before building or testing: cd ${w.path} && ${w.setup}` : '';
      return { content: [{ type: 'text', text: `Worktree ready: ${w.path} on branch ${w.branch} (from ${w.base}). Make this repository's changes there.${setup}` }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  });
  return mcp;
}

export async function handleMcp(request: Request) {
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server().connect(transport);
  return transport.handleRequest(request);
}
