import type { Session } from '../../server/db.ts';
import type { Usage } from '../../server/usage.ts';
import { menuAnswerText } from '../../server/decision.ts';
import { pauseMark } from '../../server/pause.ts';
import type { RepoView } from '../../server/workspace.ts';
import { addFromTemplate, queue, repos, ROOTS, session, titleOf, type Template } from './fixtures.ts';
import { HOME } from './home.ts';
import { BROKEN_MODEL, RETRIES_MODEL, STANDING_MODEL } from './architectureModels.ts';
import { EXPORT_FLOW, EXPORT_FLOW_PAGES, rpiDocuments, rpiVersions } from './rpiDocs.ts';

export type Flag = 'lossFails' | 'resumeFails';

export interface Scenario {
  roots: string[];
  repos: RepoView[];
  sessions: Session[];
  usage: Usage | null;
  flags: Record<string, Flag[]>;
  // Files the mock writes into its HOME when the scenario loads: by worktree, task folder and name, under .pitwall/artifacts.
  documents?: Record<string, Record<string, Record<string, string>>>;
  // Versions of those documents the board kept before the ones on disk, oldest first: by task and path.
  documentVersions?: Record<string, Record<string, string[]>>;
  // The HTML of artifacts by id, for those that have their own; any other shows a page made from its title.
  artifactHtml?: Record<string, string>;
  // Files the mock writes into its HOME under .pitwall/architecture: by checkout and name.
  architecture?: Record<string, Record<string, string>>;
}

const MIN = 60_000;

const base = (now: number, sessions: Session[]): Scenario => ({
  roots: ROOTS, repos: repos(now), sessions, flags: { 's-stripe': ['lossFails'] },
  usage: { fiveHour: { percent: 34, resetsAt: now + 133 * MIN }, sevenDay: { percent: 61, resetsAt: now + 3 * 24 * 60 * MIN }, at: now - MIN },
});

const kindOf = (s: Session) =>
  s.archived ? 'archived' : s.menu || s.question ? 'decide' : s.status === 'waiting' ? 'prompt' : s.status;

const DECIDING = ['ask', 'menu'] as const;

function crowd(now: number, counts: { decide: number; prompt: number; idle: number; working: number; exited: number }): Scenario {
  const scenario = base(now, []);
  const known = queue(now);
  let made = 0;
  const make = (template: Template) => {
    const repo = scenario.repos[made % scenario.repos.length];
    scenario.sessions.push(addFromTemplate(repo, template, { id: `v-${String(made + 1).padStart(2, '0')}`, title: titleOf(made), now: now - made * MIN }));
    made++;
  };
  for (const [kind, count] of Object.entries(counts)) {
    const kept = known.filter((s) => kindOf(s) === kind).slice(0, count);
    scenario.sessions.push(...kept);
    for (let i = kept.length; i < count; i++) {
      make(kind === 'decide' ? DECIDING[i % DECIDING.length] : kind as Template);
    }
  }
  return scenario;
}

// With `paused`, Pause had stopped the Claudes at work before the restart, so those carry its mark instead.
function restarted(now: number, fails: boolean, paused = false): Scenario {
  const sessions = queue(now).map((s): Session => (s.status === 'exited' || s.archived ? s : {
    ...s, status: 'exited', pid: null, waitingFor: null, menu: null,
    interrupted: paused && s.status === 'working' ? pauseMark(now - 2 * MIN) : { at: now - MIN, status: s.status, waitingFor: s.waitingFor, menu: s.menu },
  }));
  const scenario = base(now, sessions);
  const first = sessions.find((s) => s.interrupted && (!paused || s.interrupted.cause === 'pause'))!;
  if (fails) scenario.flags[first.id] = [...(scenario.flags[first.id] ?? []), 'resumeFails'];
  return scenario;
}

const RPI_WORKTREES = [
  [2, `${HOME}/code/worktrees/invoice-export/billing-api`, 'invoice-export'],
  [4, `${HOME}/code/worktrees/search-page/docs-site`, 'search-page'],
] as const;

const rpiTasks = (now: number) => [
  session({
    id: 's-export', repoId: 2, worktree: RPI_WORKTREES[0][1], tty: '/dev/ttys023', pid: 83120,
    title: 'Export invoices as CSV',
    firstPrompt: '/rpi:rpi Finance wants to download a month of invoices as CSV; task directory: .pitwall/artifacts/invoice-export',
    status: 'idle', createdAt: now - 3 * 60 * MIN, updatedAt: now - 4 * MIN,
    lastMessage: 'Phase 1 is done: the CSV writer formats one invoice per row, and `pnpm test csv` passes. Phase 2 streams a month from `GET /invoices/export`.',
    lastTurn: 't-export-5',
    artifacts: EXPORT_FLOW_PAGES.map((_, i) => ({ id: `art-export-${i + 1}`, title: EXPORT_FLOW, at: now - (50 - 20 * i) * MIN, version: i + 1 })),
    // A comment on the outline whose passage has been rewritten since, so it is no longer marked.
    review: {
      comments: [{
        id: 'p-export-batch', path: '.pitwall/artifacts/invoice-export/05-structure-outline-invoice-export.md', version: null,
        heading: 'Phase 2: GET /invoices/export streams a month', quote: 'Stream 500 invoices at a time', text: 'Name the batch size, and why it is 500.', at: now - 30 * MIN, sentAt: null,
      }],
      outdated: {},
    },
  }),
  session({
    id: 's-search-page', repoId: 4, worktree: RPI_WORKTREES[1][1], tty: '/dev/ttys024', pid: 83190,
    title: 'Docs search page',
    firstPrompt: '/rpi:rpi Readers cannot find a page unless they know its section; task directory: .pitwall/artifacts/search-page',
    status: 'working', createdAt: now - 40 * MIN, updatedAt: now - MIN, activity: { step: 'Read: src/pages/[...slug].astro', since: now - 2 * MIN },
  }),
];

export const scenarios: Record<string, (now: number) => Scenario> = {
  // 3 decisions, 1 Needs focus, 2 Your turn, 3 working, 2 ended, 1 archived.
  queue: (now) => base(now, queue(now)),

  freetext: (now) => base(now, [...queue(now), session({
    id: 's-flag', repoId: 1, worktree: `${HOME}/code/worktrees/guest-cart-merge/storefront`, tty: '/dev/ttys015', pid: 81240,
    title: 'Name the cart-merge feature flag', firstPrompt: 'Put the guest cart merge behind a feature flag.',
    status: 'idle', createdAt: now - 20 * MIN, updatedAt: now - 2 * MIN,
    question: {
      toolUseId: 'toolu_01Flag', category: 'plan-problem', askedAt: now - 2 * MIN, title: 'What should the feature flag be called?',
      details: 'The flag guards the new merge in `onLogin`. The other checkout flags are named `checkout.<feature>`.', options: [],
    },
    lastMessage: 'The merge is behind a flag now. What should the flag be called?', lastTurn: 't-flag-2',
  })]),

  'lone-menu': (now) => base(now, [
    ...queue(now).filter((s) => s.status === 'working' || (s.status === 'exited' && !s.archived)),
    session({
      id: 's-lone', repoId: 2, worktree: `${HOME}/code/worktrees/webhook-retries/billing-api`, tty: '/dev/ttys009', pid: 78120,
      title: 'Retry failed webhooks', firstPrompt: 'Webhook deliveries that fail are never retried (BILL-88). Add retries with backoff.',
      status: 'waiting', createdAt: now - 2 * 60 * MIN, updatedAt: now - 3 * MIN,
      menu: {
        toolUseId: 'toolu_01Lone', at: now - 3 * MIN,
        questions: [{
          header: 'Backoff', question: 'Which retry schedule should failed webhook deliveries use?', multiSelect: false,
          options: [
            { label: 'Exponential, 5 tries', description: '1 min, 5 min, 25 min, 2 h, 10 h' },
            { label: 'Every 15 min, 8 tries', description: 'Even load on receivers; gives up after 2 h' },
            { label: 'Linear, 6 tries', description: '10, 20, 30, 40, 50, 60 min' },
          ],
        }],
      },
      lastMessage: 'The retry worker is done. I asked in the terminal which schedule to use.', lastTurn: 't-lone-2',
    }),
  ]),

  long: (now) => base(now, queue(now).map((s) => (s.id === 's-hooks' && s.menu ? {
    ...s,
    menu: {
      ...s.menu,
      questions: [
        ...s.menu.questions,
        {
          header: 'Dead endpoints', question: 'When should an endpoint count as dead and stop getting deliveries at all?', multiSelect: false,
          options: [
            { label: 'After 3 deliveries give up', description: 'Counted per endpoint over a rolling 24 h; the owner re-enables it from the dashboard' },
            { label: 'After 24 h of failures', description: 'Any delivery that succeeds in between resets the clock' },
            { label: 'Never', description: 'Keep trying every new event; only the retries of each delivery stop' },
          ],
        },
      ],
    },
  } : s.id !== 's-cart' || !s.question ? s : {
    ...s,
    question: {
      ...s.question,
      details: Array(4).fill(s.question.details).join('\n\n'),
      options: [
        ...s.question.options,
        { label: 'Merge, newest wins', description: 'Take the cart that changed last when both have the same product' },
        { label: 'Merge without caps', description: 'Add up quantities and let checkout reject what is out of stock' },
        { label: 'Keep the guest cart', description: 'Replace the account cart with the guest cart' },
        { label: 'Save the guest cart for later', description: 'Keep the account cart and move guest items to a saved list' },
        { label: 'Decide per product', description: 'A dialog lists each conflicting product with both quantities' },
      ],
    },
  }))),

  'menu-stuck': (now) => base(now, queue(now).map((s) => (s.id !== 's-hooks' || !s.menu ? s : {
    ...s, answered: { key: `m:${s.menu.toolUseId}`, text: menuAnswerText(s.menu, [{ labels: ['Exponential, 5 tries'], other: '' }, { labels: ['Email the account owner'], other: '' }]), at: now - MIN },
  }))),

  'turn-long': (now) => base(now, [...queue(now), session({
    id: 's-push', repoId: 1, worktree: `${HOME}/code/worktrees/asset-uploads/storefront`, tty: '/dev/ttys017', pid: 81311,
    title: 'Keep the upload warning across folders', firstPrompt: 'Leaving the page mid-upload sometimes gives no warning. Find out why.',
    status: 'idle', createdAt: now - 90 * MIN, updatedAt: now - MIN,
    lastMessage: [
      '**#2:** I dropped that commit locally, so the selection still passes whole asset objects.',
      '**#3:** What changed is which uploads count as still running when the warning decides whether to show.',
      '- **Before:** it only counted running uploads that were also in `listingUploads`.',
      '- **Why that missed some:** `listingUploads` is cleared when you open a folder or change the search.',
      '- **Now:** it counts every entry in `uploads` that has `_uploading` set.',
      'Searching or opening a folder still clears the upload tiles, so this commit only keeps the warning working.',
      'The local branch is now 6 review commits on the latest master. It still needs `--force-with-lease`. Should I push it?',
    ].join('\n\n'),
    lastTurn: 't-push-6',
  })]),

  'ended-question': (now) => base(now, [...queue(now), session({
    id: 's-gone', repoId: 4, worktree: `${HOME}/code/worktrees/fix-anchors/docs-site`,
    title: 'Rotate the docs signing key', firstPrompt: 'Rotate the key that signs the docs deploys.',
    status: 'exited', createdAt: now - 4 * 60 * MIN, updatedAt: now - 60 * MIN,
    question: {
      toolUseId: 'toolu_01Gone', category: 'plan-problem', askedAt: now - 70 * MIN, title: 'Revoke the old key right away?',
      details: 'Deploys signed with the old key would stop verifying at once.',
      options: [{ label: 'Revoke now' }, { label: 'Revoke in a week' }],
    },
    lastMessage: 'The new key is in place. Should I revoke the old one right away?', lastTurn: 't-gone-3',
  })]),

  // A design interview that put a round of four questions to you: a choice with a recommended option, a choice with a
  // recommendation that is none of its options, an open question with one, and an open question without.
  round: (now) => base(now, [
    ...queue(now).filter((s) => s.status === 'working' || (s.status === 'exited' && !s.archived)),
    session({
      id: 's-events', repoId: 4, worktree: `${HOME}/code/worktrees/fix-anchors/docs-site`, tty: '/dev/ttys021', pid: 82110,
      title: 'Design the events page', firstPrompt: 'Grill me: I want a page that lists the events in town and learns what I like.',
      status: 'idle', createdAt: now - 12 * MIN, updatedAt: now - 2 * MIN,
      round: {
        key: 'toolu_01Round', source: 'tool', at: now - 2 * MIN, title: 'Round 1: who it is for and what it shows',
        intro: 'The repository is empty, so every decision is open. A search for event sources runs meanwhile; the questions about them wait for it.',
        questions: [
          {
            id: 'Q1', title: 'Audience', body: 'Is this a tool only for you, something for a few friends, or a product for strangers?',
            options: [
              { label: 'Only me', description: 'No accounts, no onboarding, no moderation' },
              { label: 'A few friends', description: 'Accounts, but people you know' },
              { label: 'A public product' },
            ],
            recommendation: 'Only you. That removes accounts, onboarding and most of the legal exposure of republishing listings.', recommended: 'Only me',
          },
          {
            id: 'Q2', title: 'Where you use it', body: 'When you check what is on, where are you?',
            options: [{ label: 'On the phone' }, { label: 'At the desk' }, { label: 'In a weekly digest', description: 'An email, with no page to open' }],
            recommendation: 'A page built for the phone that also works at the desk. A digest can come later from the same data.', recommended: null,
          },
          {
            id: 'Q3', title: 'What counts as an event', body: 'Listing everything pulls in very different things:\n\n- one-off events: concerts, lectures, markets\n- long runs: exhibitions open for months\n- cinema: dozens of screenings a day',
            options: [], recommendation: 'Include everything, but collapse it: an exhibition is one item with a date range, a film one item with its showtimes.', recommended: null,
          },
          { id: 'Q4', title: 'Your own sources', body: 'Name three to five sources you would add yourself.', options: [], recommendation: '', recommended: null },
        ],
      },
      lastMessage: 'The repository is empty, so every decision is open. Round 1 is posted: four questions that do not depend on the source search.',
      lastTurn: 't-events-1',
    }),
  ]),

  // The Mac restarted: every task that was running ended with it and remembers what it was doing; the two that had
  // ended before stay as they were. `restartedFails` also has one that cannot be resumed.
  restarted: (now) => restarted(now, false),
  restartedFails: (now) => restarted(now, true),
  // Paused before the restart: the Claudes that were at work carry the pause's mark, the rest the restart's.
  restartedPaused: (now) => restarted(now, false, true),
  restartedPausedFails: (now) => restarted(now, true, true),

  // Two tasks started with New task's RPI workflow, whose documents lie in their worktrees: one implementing its
  // outline, one at research.
  workflow: (now) => {
    const scenario = base(now, [...queue(now), ...rpiTasks(now)]);
    for (const [repoId, path, branch] of RPI_WORKTREES) {
      scenario.repos.find((r) => r.id === repoId)!.worktrees.push({ path, branch, head: '7'.repeat(40), isMain: false, conversations: [] });
    }
    scenario.documents = rpiDocuments(HOME);
    scenario.documentVersions = rpiVersions();
    scenario.artifactHtml = Object.fromEntries(EXPORT_FLOW_PAGES.map((html, i) => [`art-export-${i + 1}`, html]));
    return scenario;
  },

  // Billing's main checkout holds the project's architecture model; Retry failed webhooks changes it in its worktree,
  // Fix invoice PDF rounding has a copy that does not parse, and Upgrade Stripe SDK an untouched copy.
  architecture: (now) => {
    const scenario = base(now, queue(now));
    const worktree = (id: string) => scenario.sessions.find((s) => s.id === id)!.worktree;
    scenario.architecture = {
      [`${HOME}/code/billing-api`]: STANDING_MODEL,
      [worktree('s-hooks')]: RETRIES_MODEL,
      [worktree('s-invoice')]: BROKEN_MODEL,
      [worktree('s-stripe')]: STANDING_MODEL,
    };
    return scenario;
  },

  zero: (now) => base(now, queue(now).filter((s) => s.status === 'working' || (s.status === 'exited' && !s.archived))),
  empty: (now) => base(now, []),
  norepos: () => ({ roots: [], repos: [], sessions: [], usage: null, flags: {} }),

  volume: (now) => crowd(now, { decide: 14, prompt: 3, idle: 7, working: 16, exited: 3 }),
  volume20: (now) => crowd(now, { decide: 12, prompt: 3, idle: 5, working: 16, exited: 3 }),
  volume45: (now) => crowd(now, { decide: 30, prompt: 5, idle: 10, working: 16, exited: 0 }),
};
