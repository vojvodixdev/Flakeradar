import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

/**
 * Ordered list of schema migrations. Each entry runs exactly once, in a
 * transaction, and the applied version is stored in SQLite's user_version.
 * Never edit a migration that has shipped; append a new one instead.
 */
const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE projects (
    id             INTEGER PRIMARY KEY,
    slug           TEXT    NOT NULL UNIQUE,
    name           TEXT    NOT NULL,
    repository     TEXT,
    default_branch TEXT    NOT NULL DEFAULT 'main',
    token_hash     TEXT    NOT NULL UNIQUE,
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE runs (
    id              INTEGER PRIMARY KEY,
    project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    commit_sha      TEXT    NOT NULL,
    branch          TEXT    NOT NULL,
    trusted         INTEGER NOT NULL,
    ci_run_id       TEXT,
    ci_run_attempt  INTEGER NOT NULL DEFAULT 1,
    pr_number       INTEGER,
    workflow        TEXT,
    total           INTEGER NOT NULL,
    passed          INTEGER NOT NULL,
    failed          INTEGER NOT NULL,
    skipped         INTEGER NOT NULL,
    duration_ms     INTEGER NOT NULL,
    noise_failures  INTEGER NOT NULL,
    real_failures   INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    UNIQUE (project_id, ci_run_id, ci_run_attempt)
  );
  CREATE INDEX runs_project_created ON runs (project_id, created_at DESC);

  CREATE TABLE tests (
    id                  INTEGER PRIMARY KEY,
    project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key                 TEXT    NOT NULL,
    suite               TEXT    NOT NULL,
    classname           TEXT    NOT NULL,
    name                TEXT    NOT NULL,
    file                TEXT,
    status              TEXT    NOT NULL DEFAULT 'new',
    score               REAL    NOT NULL DEFAULT 0,
    runs                INTEGER NOT NULL DEFAULT 0,
    failures            INTEGER NOT NULL DEFAULT 0,
    failure_rate        REAL    NOT NULL DEFAULT 0,
    flips               INTEGER NOT NULL DEFAULT 0,
    flip_rate           REAL    NOT NULL DEFAULT 0,
    conflicting_commits INTEGER NOT NULL DEFAULT 0,
    fail_streak         INTEGER NOT NULL DEFAULT 0,
    reasons             TEXT    NOT NULL DEFAULT '[]',
    avg_duration_ms     INTEGER NOT NULL DEFAULT 0,
    quarantined         INTEGER NOT NULL DEFAULT 0,
    first_seen_at       INTEGER NOT NULL,
    last_seen_at        INTEGER NOT NULL,
    last_failed_at      INTEGER,
    UNIQUE (project_id, key)
  );
  CREATE INDEX tests_project_score ON tests (project_id, score DESC);

  CREATE TABLE executions (
    id          INTEGER PRIMARY KEY,
    run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    test_id     INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    attempt     INTEGER NOT NULL,
    status      TEXT    NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
    duration_ms INTEGER NOT NULL,
    message     TEXT,
    verdict     TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX executions_test_created ON executions (test_id, created_at DESC);
  CREATE INDEX executions_run ON executions (run_id);
  `,
];

export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
