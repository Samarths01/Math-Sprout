import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { APP_BUILD_SHA, resolveAppBuildSha } from "@/lib/app-build";
import { formatAttemptLogLine, readAttemptLog } from "@/lib/attempt-log";
import { startPracticeSession, submitAttempt } from "@/lib/attempts";
import { openDatabase } from "@/lib/db";
import { createChild, createGuardian, setConsent } from "@/lib/domain";

const cleanups: Array<() => void> = [];
const WHEN = "2026-06-15T18:00:00.000Z";

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-build-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

describe("app build tag", () => {
  it("prefers APP_BUILD_SHA, then git HEAD, then unknown", () => {
    expect(APP_BUILD_SHA.trim().length).toBeGreaterThan(0);
    expect(
      resolveAppBuildSha({ env: "abc123", readGitHead: () => "from-git" }),
    ).toBe("abc123");
    expect(
      resolveAppBuildSha({ env: "   ", readGitHead: () => "from-git" }),
    ).toBe("from-git");
    expect(resolveAppBuildSha({ env: "", readGitHead: () => "  " })).toBe("unknown");
    expect(
      resolveAppBuildSha({
        env: undefined,
        readGitHead: () => {
          throw new Error("git unavailable");
        },
      }),
    ).toBe("unknown");
  });

  it("stores a non-empty build tag on a new attempt and session, and the log line includes it", () => {
    const db = tempDb();
    const guardian = createGuardian(db, {
      email: "parent@example.com",
      password: "correct-horse",
      timezone: "America/Los_Angeles",
    });
    const child = createChild(db, guardian.id, {
      displayName: "Leo",
      timezone: "America/Los_Angeles",
    });
    setConsent(db, guardian.id, child.id, "grant");
    const session = startPracticeSession(db, guardian.id, child.id);
    const shown = new Date(Date.parse(WHEN) - 2_000).toISOString();
    const result = submitAttempt(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "build-tag-0001",
        sessionId: session.sessionId,
        itemId: "ops-g2-add",
        answer: "42",
        shownAt: shown,
        submittedAt: WHEN,
      },
      { now: WHEN },
    );

    const attempt = db
      .prepare(`SELECT build_sha, policy_version FROM attempts WHERE id = ?`)
      .get(result.attemptId) as { build_sha: string | null; policy_version: string };
    const storedSession = db
      .prepare(`SELECT build_sha, policy_version FROM practice_sessions WHERE id = ?`)
      .get(session.sessionId) as { build_sha: string | null; policy_version: string };
    expect(attempt.policy_version).toBe("rules-v0");
    expect(storedSession.policy_version).toBe("rules-v0");
    expect(attempt.build_sha).toBe(APP_BUILD_SHA);
    expect(storedSession.build_sha).toBe(APP_BUILD_SHA);
    expect(attempt.build_sha?.trim().length).toBeGreaterThan(0);

    const log = readAttemptLog(db, result.attemptId);
    const line = formatAttemptLogLine(log);
    expect(log.buildSha).toBe(APP_BUILD_SHA);
    expect(line).toContain(`policy_version=${log.policyVersion}`);
    expect(line).toContain(`build_sha=${APP_BUILD_SHA}`);
    expect(line).not.toContain("build_sha= ");

    expect(result).not.toHaveProperty("buildSha");
    expect(result.clientView).not.toHaveProperty("buildSha");
    expect(session).not.toHaveProperty("buildSha");
    expect(JSON.stringify(result)).not.toContain(APP_BUILD_SHA);
    expect(JSON.stringify(session)).not.toContain(APP_BUILD_SHA);
  });

  it("leaves build_sha null on rows that predate the column", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-build-old-"));
    const filename = path.join(dir, "old.sqlite");
    const raw = new Database(filename);
    raw.exec(`
      CREATE TABLE practice_sessions (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active')),
        item_index INTEGER NOT NULL,
        started_at TEXT NOT NULL
      );
      INSERT INTO practice_sessions (id, child_id, status, item_index, started_at)
      VALUES ('sess-old', 'child-old', 'active', 0, '2026-01-01T00:00:00.000Z');
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        item_id TEXT NOT NULL,
        answer TEXT NOT NULL,
        shown_at TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        correct INTEGER NOT NULL,
        lane TEXT NOT NULL,
        celebration_tier TEXT NOT NULL,
        flags_json TEXT NOT NULL,
        beats_json TEXT NOT NULL,
        client_view_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO attempts (
        id, child_id, session_id, idempotency_key, item_id, answer, shown_at,
        submitted_at, correct, lane, celebration_tier, flags_json, beats_json,
        client_view_json, created_at
      ) VALUES (
        'attempt-old', 'child-old', 'sess-old', 'old-key-0001', 'ops-g2-add', '42',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z', 1, 'celebrate', 'full',
        '[]', '{}', '{}', '2026-01-01T00:00:02.000Z'
      );
    `);
    raw.close();
    const db = openDatabase(filename);
    cleanups.push(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    for (const table of ["attempts", "practice_sessions"] as const) {
      const column = (
        db.pragma(`table_info(${table})`) as Array<{ name: string; notnull: number }>
      ).find((row) => row.name === "build_sha");
      expect(column?.notnull).toBe(0);
    }
    const attempt = db
      .prepare(`SELECT build_sha FROM attempts WHERE id = ?`)
      .get("attempt-old") as { build_sha: string | null };
    const session = db
      .prepare(`SELECT build_sha FROM practice_sessions WHERE id = ?`)
      .get("sess-old") as { build_sha: string | null };
    expect(attempt.build_sha).toBeNull();
    expect(session.build_sha).toBeNull();

    const log = readAttemptLog(db, "attempt-old");
    expect(log.buildSha).toBe("unknown");
    expect(formatAttemptLogLine(log)).toContain("build_sha=unknown");
  });
});
