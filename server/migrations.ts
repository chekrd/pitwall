import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, SESSIONS_DIR } from './config.ts';

type Migration = (db: DatabaseSync) => void;

const columnsOf = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));

// Each step runs once, in order, and `PRAGMA user_version` counts the steps a database has had. Add new steps at the
// end; never edit or reorder one that has shipped.
export const migrations: Migration[] = [
  // 1: the schema as it stood when steps were first numbered. A database from before then may be at any earlier shape,
  // so this one step finds out which from its columns; no later step needs to.
  (db) => {
    // Sessions used to be tmux panes; their rows and launch files cannot carry over to Ghostty tabs.
    if (columnsOf(db, 'sessions').includes('tmux')) {
      db.exec('DROP TABLE sessions');
      rmSync(SESSIONS_DIR, { recursive: true, force: true });
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        base_branch TEXT,
        setup_command TEXT,
        worktree_root TEXT,
        hidden INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
        worktree TEXT NOT NULL,
        cwd TEXT NOT NULL,
        pid INTEGER,
        tty TEXT,
        title TEXT,
        first_prompt TEXT,
        status TEXT NOT NULL,
        question TEXT,
        rank INTEGER,
        rank_reason TEXT,
        diffstat TEXT,
        last_message TEXT,
        waiting_for TEXT,
        dismissed_ask TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        advice TEXT, pr TEXT, summary TEXT, explanation TEXT, activity TEXT, menu TEXT, last_turn TEXT, artifacts TEXT,
        answered TEXT, findings TEXT, parent TEXT, resolution TEXT, conversation TEXT, history TEXT, model TEXT,
        effort TEXT, links TEXT, priority TEXT, last_prompt TEXT, interrupted TEXT, turn_error TEXT
      );
      CREATE TABLE IF NOT EXISTS roots (
        path TEXT PRIMARY KEY
      );
    `);
    const sessionColumns = columnsOf(db, 'sessions');
    for (const column of ['advice', 'pr', 'summary', 'explanation', 'activity', 'menu', 'last_turn', 'artifacts', 'answered', 'findings', 'parent', 'resolution', 'conversation', 'history', 'model', 'effort', 'links', 'priority', 'last_prompt', 'interrupted', 'turn_error']) {
      if (!sessionColumns.includes(column)) db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
    }
    db.exec('UPDATE sessions SET conversation = id WHERE conversation IS NULL');
    // A task across a folder of repos has no repository of its own, which the first sessions table did not allow.
    if (db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'repo_id' && c.notnull)) {
      const create = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()!.sql);
      db.exec(`
        ${create.replace(/CREATE TABLE "?sessions"?/, 'CREATE TABLE sessions_nullable').replace(/repo_id INTEGER NOT NULL/, 'repo_id INTEGER')};
        INSERT INTO sessions_nullable SELECT * FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_nullable RENAME TO sessions;
      `);
    }
    if (!columnsOf(db, 'repos').includes('hidden')) db.exec('ALTER TABLE repos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  },
  // 2: scheduled tasks, and the schedule each task was started by.
  (db) => {
    db.exec(`
      CREATE TABLE schedules (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      ALTER TABLE sessions ADD COLUMN scheduled TEXT;
    `);
  },
  // 3: drafts written for a task's Claude to send later.
  (db) => {
    db.exec('ALTER TABLE sessions ADD COLUMN parked TEXT');
  },
  // 4: questions asked on the side, each answered by a fork of the task's conversation.
  (db) => {
    db.exec('ALTER TABLE sessions ADD COLUMN asides TEXT');
  },
  // 5: when the sync last saw each task's Claude alive, which tells the Claudes a restart ended from the others.
  (db) => {
    db.exec('ALTER TABLE sessions ADD COLUMN alive_at INTEGER');
  },
  // 6: a task whose worktree is still being made behind its card, or could not be.
  (db) => {
    db.exec('ALTER TABLE sessions ADD COLUMN starting TEXT');
  },
  // 7: archiving now forgets the restart that ended a task; tasks archived before then still carried it.
  (db) => {
    db.exec(`UPDATE sessions SET interrupted = NULL WHERE archived = 1 AND interrupted IS NOT NULL AND json_extract(interrupted, '$.cause') IS NOT 'pause'`);
  },
  // 8: each task's latest message that Claude has not replied to yet.
  (db) => {
    db.exec('ALTER TABLE sessions ADD COLUMN unanswered TEXT');
  },
  // 9: the round of questions each task waits on, and the one last answered or dismissed on the board.
  (db) => {
    db.exec('ALTER TABLE sessions ADD COLUMN round TEXT; ALTER TABLE sessions ADD COLUMN dismissed_round TEXT');
  },
  // 10: how much of the context window each task's conversation fills.
  (db) => {
    db.exec('ALTER TABLE sessions ADD COLUMN context INTEGER');
  },
  // 11: the model runs per task are gone: second opinions, summaries, explanations, findings with their subtasks, and
  // the ranking with the priority it weighed. A subtask's row stays as a task of its own. The second opinions' scratch
  // copies lived in the state folder's advisor/; with it gone, git lists those worktrees as prunable, which the board skips.
  (db) => {
    for (const column of ['advice', 'summary', 'explanation', 'findings', 'parent', 'resolution', 'rank', 'rank_reason', 'priority']) {
      db.exec(`ALTER TABLE sessions DROP COLUMN ${column}`);
    }
    rmSync(join(DATA_DIR, 'advisor'), { recursive: true, force: true });
  },
  // 12: an artifact published again under its title is a new version of it, all of them kept. Each artifact stored
  // before then was the only one of its title and becomes its version 1.
  (db) => {
    const update = db.prepare('UPDATE sessions SET artifacts = ? WHERE id = ?');
    for (const row of db.prepare('SELECT id, artifacts FROM sessions WHERE artifacts IS NOT NULL').all()) {
      const list = JSON.parse(String(row.artifacts)) as { title: string; at: number; version?: number }[];
      const seen = new Map<string, number>();
      const versioned = list.map((a) => {
        const version = a.version ?? (seen.get(a.title) ?? 0) + 1;
        seen.set(a.title, version);
        return { ...a, version };
      });
      update.run(JSON.stringify(versioned), row.id as string);
    }
  },
  // 13: comments on rpi documents leave Later for the documents' own panel, each kept there moving to it unsent.
  (db) => {
    db.exec('ALTER TABLE sessions ADD COLUMN review TEXT');
    type Kept = { id: string; text: string; at: number; ref?: { kind?: string; path: string; heading: string | null; quote: string; version?: number } };
    const update = db.prepare('UPDATE sessions SET parked = ?, review = ? WHERE id = ?');
    for (const row of db.prepare('SELECT id, parked FROM sessions WHERE parked IS NOT NULL').all()) {
      const list = JSON.parse(String(row.parked)) as Kept[];
      const onDocuments = list.filter((p) => p.ref?.kind === 'document');
      if (!onDocuments.length) continue;
      const comments = onDocuments.map(({ id, text, at, ref }) => ({ id, path: ref!.path, version: ref!.version ?? null, quote: ref!.quote, heading: ref!.heading, text, at, sentAt: null }));
      update.run(JSON.stringify(list.filter((p) => p.ref?.kind !== 'document')), JSON.stringify({ comments, outdated: {} }), row.id as string);
    }
  },
];

export function migrate(db: DatabaseSync, steps = migrations) {
  const done = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (done > steps.length) throw new Error(`the database has had ${done} migrations, more than the ${steps.length} this Pitwall knows`);
  for (let i = done; i < steps.length; i++) {
    db.exec('BEGIN');
    try {
      steps[i](db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
