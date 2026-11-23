import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DATA_DIR } from './config.ts';
import { migrate, migrations } from './migrations.ts';

const version = (db: DatabaseSync) => Number(db.prepare('PRAGMA user_version').get()!.user_version);
const columns = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => ({ name: String(c.name), notnull: !!c.notnull }));

test('a new database gets every step and the full schema', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  assert.equal(version(db), migrations.length);
  const sessions = columns(db, 'sessions');
  for (const name of ['conversation', 'turn_error', 'last_prompt', 'context']) assert.ok(sessions.some((c) => c.name === name), name);
  for (const name of ['advice', 'summary', 'parent', 'rank', 'priority']) assert.ok(!sessions.some((c) => c.name === name), name);
  assert.equal(sessions.find((c) => c.name === 'repo_id')!.notnull, false);
  assert.ok(columns(db, 'repos').some((c) => c.name === 'hidden'));
  assert.ok(sessions.some((c) => c.name === 'scheduled'));
  assert.ok(sessions.some((c) => c.name === 'alive_at'));
  assert.ok(columns(db, 'schedules').length);
});

test('a database from before numbered steps keeps its rows and reaches the same schema', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE repos (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, base_branch TEXT, setup_command TEXT, worktree_root TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE, worktree TEXT NOT NULL,
      cwd TEXT NOT NULL, pid INTEGER, tty TEXT, title TEXT, first_prompt TEXT, status TEXT NOT NULL, question TEXT, rank INTEGER,
      rank_reason TEXT, diffstat TEXT, last_message TEXT, waiting_for TEXT, dismissed_ask TEXT, archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, advice TEXT);
    INSERT INTO repos (id, path) VALUES (1, '/r');
    INSERT INTO sessions (id, repo_id, worktree, cwd, status, title, created_at, updated_at, advice) VALUES ('s1', 1, '/r', '/r', 'idle', 'old', 1, 2, '{}');
  `);
  migrate(db);
  const fresh = new DatabaseSync(':memory:');
  migrate(fresh);
  const names = (d: DatabaseSync, t: string) => columns(d, t).map((c) => c.name).sort();
  assert.deepEqual(names(db, 'sessions'), names(fresh, 'sessions'));
  assert.deepEqual(names(db, 'repos'), names(fresh, 'repos'));
  assert.equal(columns(db, 'sessions').find((c) => c.name === 'repo_id')!.notnull, false);
  const row = db.prepare('SELECT * FROM sessions').get()!;
  assert.equal(row.conversation, 's1');
  assert.equal(row.title, 'old');
  assert.equal(version(db), migrations.length);
});

test('steps already counted do not run again, and a failed step leaves the database as it was', () => {
  const db = new DatabaseSync(':memory:');
  const runs: number[] = [];
  const steps = [
    (d: DatabaseSync) => {
      runs.push(1);
      d.exec('CREATE TABLE a (x)');
    },
    (d: DatabaseSync) => {
      runs.push(2);
      d.exec('CREATE TABLE b (x)');
      throw new Error('boom');
    },
  ];
  assert.throws(() => migrate(db, steps), /boom/);
  assert.equal(version(db), 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'b'").get()!.n, 0);
  assert.throws(() => migrate(db, steps), /boom/);
  assert.deepEqual(runs, [1, 2, 2]);
  assert.throws(() => migrate(db, []), /more than the 0/);
});

test('step 7 forgets the restart on tasks archived before archiving did, and keeps it on the rest and a pause on any', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, migrations.slice(0, 6));
  const restart = JSON.stringify({ at: 1, status: 'idle', waitingFor: null, menu: null });
  const pause = JSON.stringify({ at: 1, cause: 'pause', status: 'working', waitingFor: null, menu: null });
  const add = db.prepare("INSERT INTO sessions (id, worktree, cwd, status, archived, interrupted, created_at, updated_at, conversation) VALUES (?, '/r', '/r', 'exited', ?, ?, 1, 1, ?)");
  for (const [id, archived, interrupted] of [['gone', 1, restart], ['paused', 1, pause], ['shown', 0, restart], ['plain', 1, null]] as const) add.run(id, archived, interrupted, id);
  migrate(db);
  const rows = Object.fromEntries(db.prepare('SELECT id, interrupted FROM sessions').all().map((r) => [r.id, r.interrupted]));
  assert.deepEqual(rows, { gone: null, paused: pause, shown: restart, plain: null });
});

test('step 11 drops the columns of the model runs and keeps each task, a subtask as a task of its own', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, migrations.slice(0, 10));
  const add = db.prepare(`INSERT INTO sessions (id, worktree, cwd, status, title, archived, parent, resolution, summary, advice, rank, priority, created_at, updated_at, conversation)
    VALUES (?, '/r', '/r', 'idle', ?, ?, ?, ?, '{}', '{}', 1, 'high', 1, 1, ?)`);
  add.run('task', 'review', 0, null, null, 'task');
  mkdirSync(join(DATA_DIR, 'advisor', 'left-over'), { recursive: true });
  add.run('fix', '#1 Fix · a bug', 1, JSON.stringify({ id: 'task', basis: 't1', finding: 0, title: 'a bug', kind: 'accept', text: '' }), JSON.stringify({ state: 'solved', at: 1 }), 'fix');
  migrate(db);
  assert.equal(version(db), migrations.length);
  assert.ok(!existsSync(join(DATA_DIR, 'advisor')));
  const names = columns(db, 'sessions').map((c) => c.name);
  for (const gone of ['advice', 'summary', 'explanation', 'findings', 'parent', 'resolution', 'rank', 'rank_reason', 'priority']) assert.ok(!names.includes(gone), gone);
  for (const kept of ['question', 'round', 'menu', 'answered', 'unanswered', 'parked']) assert.ok(names.includes(kept), kept);
  assert.deepEqual(db.prepare('SELECT id, title, archived FROM sessions ORDER BY id').all().map((r) => ({ ...r })), [
    { id: 'fix', title: '#1 Fix · a bug', archived: 1 },
    { id: 'task', title: 'review', archived: 0 },
  ]);
});

test('step 12 makes each stored artifact version 1 of its title', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, migrations.slice(0, 11));
  const add = db.prepare("INSERT INTO sessions (id, worktree, cwd, status, artifacts, created_at, updated_at, conversation) VALUES (?, '/r', '/r', 'idle', ?, 1, 1, ?)");
  add.run('two', JSON.stringify([{ id: 'a', title: 'Flow', at: 1 }, { id: 'b', title: 'States', at: 2 }]), 'two');
  add.run('none', null, 'none');
  migrate(db);
  assert.equal(version(db), migrations.length);
  const rows = Object.fromEntries(db.prepare('SELECT id, artifacts FROM sessions').all().map((r) => [r.id, r.artifacts && JSON.parse(String(r.artifacts))]));
  assert.deepEqual(rows, { two: [{ id: 'a', title: 'Flow', at: 1, version: 1 }, { id: 'b', title: 'States', at: 2, version: 1 }], none: null });
});

test('step 13 moves each draft about a document passage out of Later into the comments, unsent, and leaves the other drafts', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, migrations.slice(0, 12));
  const doc = '.pitwall/artifacts/t/04-design-discussion-t.md';
  const lines = { id: 'l', text: 'Make it const.', auto: true, armedAt: 5, at: 1, ref: { path: 'a.ts', side: 'new', start: 3, end: 3, lines: ['let a = 1;'] } };
  const plain = { id: 'p', text: 'Also the credit notes.', auto: false, armedAt: null, at: 2 };
  const onV2 = { id: 'c1', text: 'Why stream?', auto: false, armedAt: null, at: 3, ref: { kind: 'document', path: doc, heading: 'Stream?', quote: 'Streaming starts', version: 2 } };
  const old = { id: 'c2', text: 'Name the batch.', auto: true, armedAt: 4, at: 4, ref: { kind: 'document', path: doc, heading: null, quote: 'Stream 500' } };
  const add = db.prepare("INSERT INTO sessions (id, worktree, cwd, status, parked, created_at, updated_at, conversation) VALUES (?, '/r', '/r', 'idle', ?, 1, 1, ?)");
  add.run('mixed', JSON.stringify([lines, onV2, plain, old]), 'mixed');
  add.run('drafts', JSON.stringify([plain]), 'drafts');
  add.run('none', null, 'none');
  migrate(db);
  assert.equal(version(db), migrations.length);
  const rows = Object.fromEntries(db.prepare('SELECT id, parked, review FROM sessions').all()
    .map((r) => [r.id, { parked: r.parked && JSON.parse(String(r.parked)), review: r.review && JSON.parse(String(r.review)) }]));
  assert.deepEqual(rows, {
    mixed: {
      parked: [lines, plain],
      review: {
        comments: [
          { id: 'c1', path: doc, version: 2, quote: 'Streaming starts', heading: 'Stream?', text: 'Why stream?', at: 3, sentAt: null },
          { id: 'c2', path: doc, version: null, quote: 'Stream 500', heading: null, text: 'Name the batch.', at: 4, sentAt: null },
        ],
        outdated: {},
      },
    },
    drafts: { parked: [plain], review: null },
    none: { parked: null, review: null },
  });
});
