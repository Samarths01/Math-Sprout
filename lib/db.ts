import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS guardians (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  timezone TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS children (
  id TEXT PRIMARY KEY,
  guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consents (
  child_id TEXT PRIMARY KEY REFERENCES children(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('granted', 'paused', 'revoked')),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES guardians(id)
);

CREATE INDEX IF NOT EXISTS children_guardian_id ON children(guardian_id);
CREATE INDEX IF NOT EXISTS sessions_guardian_id ON sessions(guardian_id);

CREATE TABLE IF NOT EXISTS practice_sessions (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active')),
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  started_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  shown_at TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  lane TEXT NOT NULL CHECK (lane IN ('celebrate', 'review')),
  celebration_tier TEXT NOT NULL CHECK (celebration_tier IN ('sprout', 'quietXp', 'none')),
  flags_json TEXT NOT NULL,
  beats_json TEXT NOT NULL,
  client_view_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (child_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS xp_events (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount IN (1, 5)),
  celebration_tier TEXT NOT NULL CHECK (celebration_tier IN ('sprout', 'quietXp')),
  minted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS practice_sessions_child_id ON practice_sessions(child_id);
CREATE INDEX IF NOT EXISTS attempts_child_submitted ON attempts(child_id, submitted_at);
`;

export function openDatabase(filename: string): Database.Database {
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  if (filename !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.exec(MIGRATION);
  return db;
}

export function databasePath(): string {
  return (
    process.env.DATABASE_PATH ??
    path.join(process.cwd(), "data", "math-sprout.sqlite")
  );
}

const globalForDb = globalThis as typeof globalThis & {
  __mathSproutDb?: Database.Database;
};

export function getDb(): Database.Database {
  if (!globalForDb.__mathSproutDb) {
    globalForDb.__mathSproutDb = openDatabase(databasePath());
  }
  return globalForDb.__mathSproutDb;
}
