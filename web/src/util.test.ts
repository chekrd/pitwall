import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menu, options, question, session } from './testing.ts';
import type { RepoView } from './types.ts';
import { attentionChangesAt, attentionOf, clock, contextUse, decisionOf, isDelivered, locate, menuStuck, modelName, share, shortUrl, tilde, tildeIn, untilde, worktreeName } from './util.ts';

test('a decision is the open ask_human question, and one the board answered is closed at once', () => {
  const asked = session('s', { question: question('q1') });
  assert.deepEqual(decisionOf(asked), { key: 'q:q1', problem: 'Which cart wins?', context: 'd', options: options('Keep', 'Merge') });
  assert.equal(decisionOf({ ...asked, answered: { key: 'q:q1', text: 'Keep', at: 5 } }), null);
  assert.equal(decisionOf(session('s', { lastMessage: 'All green. Ship it?' })), null, 'a question in plain text is your turn');
  assert.equal(attentionOf(session('s', { lastMessage: 'All green. Ship it?' })), 'idle');
  assert.equal(decisionOf(session('s', { status: 'waiting', menu: menu('m1') })), null, 'a menu has its own view');
});

test('an ended session with an open question has ended; it is not a decision any more', () => {
  assert.equal(attentionOf(session('s', { status: 'exited', question: question('q1') })), 'exited');
  assert.equal(attentionOf(session('s', { question: question('q1') })), 'decide');
});

test('a menu answered from the board counts as working for 10 s, then needs focus: Claude still shows it', () => {
  const answered = session('s', { status: 'waiting', menu: menu('m1'), answered: { key: 'm:m1', text: 'Backoff: Linear', at: 100_000 } });
  assert.equal(attentionOf(answered, 100_000), 'working');
  assert.equal(attentionOf(answered, 109_999), 'working');
  assert.equal(menuStuck(answered, 109_999), false);
  assert.equal(attentionOf(answered, 110_000), 'focus');
  assert.equal(menuStuck(answered, 110_000), true);
  assert.equal(attentionChangesAt(answered), 110_000);
  const going = { ...answered, status: 'working' as const };
  assert.equal(attentionOf(going, 200_000), 'working', 'Claude went on, so the menu is closed; the transcript lags');
  assert.equal(menuStuck(going, 200_000), false);
  const unanswered = { ...answered, answered: { key: 'q:other', text: 'x', at: 100_000 } };
  assert.equal(attentionOf(unanswered, 100_000), 'decide');
  assert.equal(attentionChangesAt(unanswered), null);
});

test('clock shows a time on the 24-hour clock, with the weekday when asked', () => {
  const at = new Date(2026, 9, 26, 14, 5).getTime();
  assert.equal(clock(at), '14:05');
  assert.equal(clock(new Date(2026, 9, 26, 0, 7).getTime()), '00:07');
  assert.match(clock(at, true), /^Mon,? 14:05$/);
});

test('a path under the home folder starts with ~, any other stays whole', () => {
  assert.equal(tilde('/Users/me/git/board', '/Users/me'), '~/git/board');
  assert.equal(tilde('/Users/me', '/Users/me'), '~');
  assert.equal(tilde('/Users/meg/git', '/Users/me'), '/Users/meg/git');
  assert.equal(tilde('/opt/x', ''), '/opt/x');
});

test('a typed path starting with ~ means the home folder', () => {
  assert.equal(untilde('~/code/x', '/Users/me'), '/Users/me/code/x');
  assert.equal(untilde('~', '/Users/me'), '/Users/me');
  assert.equal(untilde('~me/x', '/Users/me'), '~me/x');
  assert.equal(untilde('/opt/x', '/Users/me'), '/opt/x');
});

test('text names the home folder as ~ wherever a path starts there', () => {
  assert.equal(tildeIn('Read /Users/me/git/a.ts and /Users/me', '/Users/me'), 'Read ~/git/a.ts and ~');
  assert.equal(tildeIn('cd "/Users/me/x" && ls /Users/meg /Data/Users/me/y', '/Users/me'), 'cd "~/x" && ls /Users/meg /Data/Users/me/y');
  assert.equal(tildeIn('/Users/me/x', ''), '/Users/me/x');
});

test('a worktree is named by its folder, without the repository folder git-wt puts in it; the main checkout and a removed worktree are none', () => {
  const repo = { path: '/g/board', name: 'board', worktrees: [{ path: '/g/board' }, { path: '/g/worktrees/review/board' }, { path: '/g/worktrees/spike' }] } as RepoView;
  assert.equal(worktreeName('/g/worktrees/review/board', repo), 'review');
  assert.equal(worktreeName('/g/worktrees/spike', repo), 'spike');
  assert.equal(worktreeName('/g/board', repo), 'None');
  assert.equal(worktreeName('/g/worktrees/gone/board', repo), 'None');
  assert.equal(worktreeName('/g/worktrees/x/board', undefined), 'board');
});

test('a link reads as its host and path', () => {
  assert.equal(shortUrl('https://www.github.com/o/r/pull/42/'), 'github.com/o/r/pull/42');
  assert.equal(shortUrl('https://x.dev/a?b=1'), 'x.dev/a?b=1');
  assert.equal(shortUrl('not a url'), 'not a url');
});

test('pull requests and claude.ai pages are told apart from other links', () => {
  for (const url of [
    'https://github.com/o/r/pull/42',
    'https://github.com/o/r/pull/42/files',
    'https://dev.azure.com/o/p/_git/r/pullrequest/7',
    'https://gitlab.com/g/r/-/merge_requests/3',
    'https://claude.ai/artifact/9QsVfDkHMHJwhbwst8dnxB',
    'https://claude.ai/code/artifact/0b5f-41c2',
  ]) assert.ok(isDelivered(url), url);
  for (const url of [
    'https://github.com/o/r/pulls',
    'https://github.com/o/r/issues/42',
    'https://jira.example.com/browse/CHK-412',
    'https://claude.ai/chat/abc',
    'https://react.dev/reference/react/Suspense',
  ]) assert.ok(!isDelivered(url), url);
});

test('a model id reads as its family and version', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-sonnet-5-5[1m]'), 'Sonnet 5.5');
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.deepEqual([modelName('sonnet'), modelName('opus[1m]')], ['Sonnet', 'Opus'], 'an alias not yet seen running');
  assert.equal(modelName('claude-fable-5'), 'Fable 5');
  assert.equal(modelName('gpt-5.1'), 'gpt-5.1');
});

test('a task is placed in its repository on its branch; a removed worktree reads as its task folder, not the repository folder git-wt ends it with', () => {
  const repo = { id: 1, path: '/g/client', name: 'client', worktrees: [{ path: '/g/client', branch: 'main' }, { path: '/g/worktrees/asset/client', branch: 'asset' }] } as RepoView;
  const at = (worktree: string, repoId: number | null = 1) => locate([repo], session('s', { repoId, worktree }));
  assert.deepEqual([at('/g/worktrees/asset/client').place, at('/g/worktrees/asset/client').branch], ['client', 'asset']);
  assert.equal(at('/g/worktrees/gone/client').branch, 'gone');
  assert.equal(at('/g/worktrees/spike').branch, 'spike');
});

test('a folder task is placed in the repositories it opened worktrees in, on their branches, and in its folder before it opened any', () => {
  const client = { id: 1, path: '/k/client', name: 'client', worktrees: [{ path: '/k/client', branch: 'main', isMain: true }, { path: '/k/worktrees/fix/client', branch: 'fix', isMain: false }] } as RepoView;
  const api = { id: 2, path: '/k/api', name: 'api', worktrees: [{ path: '/k/api', branch: 'main', isMain: true }, { path: '/k/worktrees/fix/api', branch: 'fix-api', isMain: false }] } as RepoView;
  const fix = locate([client, api], session('s', { repoId: null, worktree: '/k/worktrees/fix' }));
  assert.deepEqual([fix.place, fix.branch], ['client, api', 'fix, fix-api']);
  const fresh = locate([client, api], session('s', { repoId: null, worktree: '/k/worktrees/new' }));
  assert.deepEqual([fresh.place, fresh.branch], ['k', 'new']);
});

test('share keeps each part equal to the one before as that very object: a session, a list, a field; a changed session is new, and its unchanged parts stay', () => {
  const cart = session('cart', { question: question('q1') });
  const hooks = session('hooks', { status: 'waiting', menu: menu('m1') });
  const before = { sessions: [cart, hooks], repos: [{ id: 1, name: 'shop', worktrees: [{ path: '/w', branch: 'main' }] }], usage: null };
  assert.equal(share(before, structuredClone(before)), before);

  const moved = structuredClone(before);
  moved.sessions = [moved.sessions[1], { ...moved.sessions[0], status: 'working' }];
  const next = share(before, moved);
  assert.notEqual(next, before);
  assert.equal(next.repos, before.repos);
  assert.equal(next.sessions[0], hooks, 'matched by id, though it moved');
  assert.notEqual(next.sessions[1], cart);
  assert.equal(next.sessions[1].status, 'working');
  assert.equal(next.sessions[1].question, cart.question);
  assert.equal(next.sessions[1].history, cart.history);

  const fewer = share(before.sessions, [structuredClone(cart)]);
  assert.notEqual(fewer, before.sessions);
  assert.equal(fewer[0], cart);
  assert.deepEqual(Object.keys(share({ a: 1 }, { a: 1, b: undefined })), ['a', 'b'], 'a key that came is kept');
});

test('the context reads as a share of the window, a 1M one for a [1m] model or past 200k tokens, amber from 50 % and red from 80 %', () => {
  assert.deepEqual(contextUse({ context: 84_200, model: 'claude-opus-5-5' }), { percent: 42, level: 'low', tokens: '84k of 200k tokens' });
  assert.deepEqual(contextUse({ context: 84_200, model: 'opus[1m]' }), { percent: 8, level: 'low', tokens: '84k of 1M tokens' });
  assert.deepEqual(contextUse({ context: 620_000, model: 'claude-opus-5-5' }), { percent: 62, level: 'mid', tokens: '620k of 1M tokens' });
  assert.equal(contextUse({ context: 170_000, model: 'claude-opus-5-5' })?.level, 'high');
  assert.equal(contextUse({ context: null, model: 'claude-opus-5-5' }), null);
});
