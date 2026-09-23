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
  started_at TEXT NOT NULL,
  practice_lane TEXT NOT NULL DEFAULT 'recommended' CHECK (practice_lane IN ('recommended', 'challenge', 'review')),
  phase TEXT NOT NULL DEFAULT 'practicing' CHECK (phase IN ('practicing', 'boundary', 'closed')),
  progression TEXT CHECK (progression IN ('stay', 'remediate', 'levelUpSlight'))
);

CREATE TABLE IF NOT EXISTS learner_skill_state (
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  skill TEXT NOT NULL,
  band_label TEXT NOT NULL CHECK (band_label IN ('Still learning', 'Getting it', 'Got it')),
  show_concept_chip INTEGER NOT NULL CHECK (show_concept_chip IN (0, 1)),
  celebration_tier TEXT NOT NULL CHECK (celebration_tier IN ('none', 'quietXp', 'full')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (child_id, skill)
);

CREATE TABLE IF NOT EXISTS learner_progress (
  child_id TEXT PRIMARY KEY REFERENCES children(id) ON DELETE CASCADE,
  next_lane TEXT NOT NULL DEFAULT 'recommended' CHECK (next_lane IN ('recommended', 'challenge', 'review')),
  difficulty_step INTEGER NOT NULL DEFAULT 0 CHECK (difficulty_step >= 0),
  streak_state TEXT NOT NULL DEFAULT 'dormant' CHECK (streak_state IN ('hot', 'warm', 'ember', 'dormant')),
  ember_expires_at TEXT,
  last_qualifying_day TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boundary_events (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE REFERENCES practice_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('level_up_slight')),
  created_at TEXT NOT NULL
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
  celebration_tier TEXT NOT NULL CHECK (celebration_tier IN ('none', 'quietXp', 'full')),
  flags_json TEXT NOT NULL,
  beats_json TEXT NOT NULL,
  client_view_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (child_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS qualifying_events (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'HonestAttempt',
    'ConceptProgressTick',
    'MasteryBandTransition',
    'LevelUpSlight',
    'QualifyingPracticeDay',
    'BadgeMilestone',
    'BuildPieceUnlock'
  )),
  idempotency_key TEXT NOT NULL,
  attempt_id TEXT REFERENCES attempts(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES practice_sessions(id) ON DELETE CASCADE,
  skill TEXT,
  local_day TEXT,
  qualifies INTEGER NOT NULL DEFAULT 0 CHECK (qualifies IN (0, 1)),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (child_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS xp_events (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount IN (1, 5)),
  celebration_tier TEXT NOT NULL CHECK (celebration_tier IN ('quietXp', 'full')),
  minted_at TEXT NOT NULL,
  qualifying_event_id TEXT NOT NULL REFERENCES qualifying_events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS practice_sessions_child_id ON practice_sessions(child_id);
CREATE INDEX IF NOT EXISTS attempts_child_submitted ON attempts(child_id, submitted_at);
CREATE INDEX IF NOT EXISTS qualifying_events_child_day ON qualifying_events(child_id, kind, local_day);
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
  migrateSproutTier(db);
  migrateLearnerProgression(db);
  migrateEconomy(db);
  return db;
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** Slice 2 databases predate practice lanes and persisted skill chips. */
export function migrateLearnerProgression(db: Database.Database): void {
  const sessions = tableColumns(db, "practice_sessions");
  if (sessions.size === 0) return;
  if (!sessions.has("practice_lane")) {
    db.exec(
      `ALTER TABLE practice_sessions ADD COLUMN practice_lane TEXT NOT NULL DEFAULT 'recommended' CHECK (practice_lane IN ('recommended', 'challenge', 'review'))`,
    );
  }
  if (!sessions.has("phase")) {
    db.exec(
      `ALTER TABLE practice_sessions ADD COLUMN phase TEXT NOT NULL DEFAULT 'practicing' CHECK (phase IN ('practicing', 'boundary', 'closed'))`,
    );
  }
  if (!sessions.has("progression")) {
    db.exec(
      `ALTER TABLE practice_sessions ADD COLUMN progression TEXT CHECK (progression IN ('stay', 'remediate', 'levelUpSlight'))`,
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS learner_skill_state (
      child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
      skill TEXT NOT NULL,
      band_label TEXT NOT NULL CHECK (band_label IN ('Still learning', 'Getting it', 'Got it')),
      show_concept_chip INTEGER NOT NULL CHECK (show_concept_chip IN (0, 1)),
      celebration_tier TEXT NOT NULL CHECK (celebration_tier IN ('none', 'quietXp', 'full')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (child_id, skill)
    );
    CREATE TABLE IF NOT EXISTS learner_progress (
      child_id TEXT PRIMARY KEY REFERENCES children(id) ON DELETE CASCADE,
      next_lane TEXT NOT NULL DEFAULT 'recommended' CHECK (next_lane IN ('recommended', 'challenge', 'review')),
      difficulty_step INTEGER NOT NULL DEFAULT 0 CHECK (difficulty_step >= 0),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS boundary_events (
      id TEXT PRIMARY KEY,
      child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE REFERENCES practice_sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('level_up_slight')),
      created_at TEXT NOT NULL
    );
  `);
}

function migrateSproutTier(db: Database.Database): void {
  const attempts = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attempts'")
    .get() as { sql: string } | undefined;
  if (!attempts?.sql.includes("'sprout'")) return;

  const previous = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE attempts__next (
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
        celebration_tier TEXT NOT NULL CHECK (celebration_tier IN ('none', 'quietXp', 'full')),
        flags_json TEXT NOT NULL,
        beats_json TEXT NOT NULL,
        client_view_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (child_id, idempotency_key)
      );
      INSERT INTO attempts__next (
        id, child_id, session_id, idempotency_key, item_id, answer, shown_at,
        submitted_at, correct, lane, celebration_tier, flags_json, beats_json,
        client_view_json, created_at
      )
      SELECT
        id, child_id, session_id, idempotency_key, item_id, answer, shown_at,
        submitted_at, correct, lane,
        CASE celebration_tier WHEN 'sprout' THEN 'full' ELSE celebration_tier END,
        flags_json, beats_json, client_view_json, created_at
      FROM attempts;
      DROP TABLE attempts;
      ALTER TABLE attempts__next RENAME TO attempts;

      CREATE TABLE xp_events__next (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
        child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
        amount INTEGER NOT NULL CHECK (amount IN (1, 5)),
        celebration_tier TEXT NOT NULL CHECK (celebration_tier IN ('quietXp', 'full')),
        minted_at TEXT NOT NULL
      );
      INSERT INTO xp_events__next (
        id, attempt_id, child_id, amount, celebration_tier, minted_at
      )
      SELECT
        id, attempt_id, child_id, amount,
        CASE celebration_tier WHEN 'sprout' THEN 'full' ELSE celebration_tier END,
        minted_at
      FROM xp_events;
      DROP TABLE xp_events;
      ALTER TABLE xp_events__next RENAME TO xp_events;

      CREATE INDEX IF NOT EXISTS practice_sessions_child_id ON practice_sessions(child_id);
      CREATE INDEX IF NOT EXISTS attempts_child_submitted ON attempts(child_id, submitted_at);
    `);
  });
  try {
    run();
  } finally {
    db.pragma(`foreign_keys = ${previous === 0 ? "OFF" : "ON"}`);
  }
}

/** Slice 4: QualifyingEvent bus, XP credits that point at it, and streak columns. */
export function migrateEconomy(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qualifying_events (
      id TEXT PRIMARY KEY,
      child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN (
        'HonestAttempt',
        'ConceptProgressTick',
        'MasteryBandTransition',
        'LevelUpSlight',
        'QualifyingPracticeDay',
        'BadgeMilestone',
        'BuildPieceUnlock'
      )),
      idempotency_key TEXT NOT NULL,
      attempt_id TEXT REFERENCES attempts(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES practice_sessions(id) ON DELETE CASCADE,
      skill TEXT,
      local_day TEXT,
      qualifies INTEGER NOT NULL DEFAULT 0 CHECK (qualifies IN (0, 1)),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (child_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS qualifying_events_child_day
      ON qualifying_events(child_id, kind, local_day);
  `);
  const xp = tableColumns(db, "xp_events");
  if (xp.size > 0 && !xp.has("qualifying_event_id")) {
    db.exec(
      `ALTER TABLE xp_events ADD COLUMN qualifying_event_id TEXT REFERENCES qualifying_events(id) ON DELETE CASCADE`,
    );
  }
  const progress = tableColumns(db, "learner_progress");
  if (progress.size > 0 && !progress.has("streak_state")) {
    db.exec(
      `ALTER TABLE learner_progress ADD COLUMN streak_state TEXT NOT NULL DEFAULT 'dormant' CHECK (streak_state IN ('hot', 'warm', 'ember', 'dormant'))`,
    );
  }
  if (progress.size > 0 && !progress.has("ember_expires_at")) {
    db.exec(`ALTER TABLE learner_progress ADD COLUMN ember_expires_at TEXT`);
  }
  if (progress.size > 0 && !progress.has("last_qualifying_day")) {
    db.exec(`ALTER TABLE learner_progress ADD COLUMN last_qualifying_day TEXT`);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS xp_events_no_update
    BEFORE UPDATE ON xp_events
    BEGIN
      SELECT RAISE(ABORT, 'xp credits are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS xp_events_require_bus
    BEFORE INSERT ON xp_events
    WHEN NEW.qualifying_event_id IS NULL OR length(NEW.qualifying_event_id) = 0
    BEGIN
      SELECT RAISE(ABORT, 'XP requires a qualifying event');
    END;
    CREATE TRIGGER IF NOT EXISTS qualifying_events_no_update
    BEFORE UPDATE ON qualifying_events
    BEGIN
      SELECT RAISE(ABORT, 'qualifying events are append-only');
    END;
  `);
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
