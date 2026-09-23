import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type DatabaseT from "better-sqlite3";
import { startPracticeSession, submitAttempt, type SubmitAttemptInput } from "@/lib/attempts";
import { projectBadges } from "@/lib/badges";
import { choosePracticeLane, endPracticeSession } from "@/lib/boundary";
import {
  BUILD_GOALS,
  PIECE_EVENT_KINDS,
  projectBuildGoal,
  projectBuildGoalFromPieces,
  type ProjectedPiece,
} from "@/lib/build-goal";
import { readCompanion } from "@/lib/companion";
import { openDatabase } from "@/lib/db";
import { createChild, createGuardian, getChildHome, getParentHome, PARENT_HOME_NARRATIVE, setConsent } from "@/lib/domain";
import { INTERFACE_COPY } from "@/lib/interface-copy";
import type { CelebrationTier } from "@/lib/attempt-contract";

const cleanups: Array<() => void> = [];

function tempDb(): DatabaseT.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-slice5-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function grantedChild(db: DatabaseT.Database) {
  const guardian = createGuardian(db, {
    email: "parent@example.com",
    password: "correct-horse",
    timezone: "America/Los_Angeles",
  });
  const child = createChild(db, guardian.id, {
    displayName: "Ava",
    timezone: "America/Los_Angeles",
  });
  setConsent(db, guardian.id, child.id, "grant");
  const session = startPracticeSession(db, guardian.id, child.id);
  return { guardian, child, session };
}

function tryInput(
  sessionId: string,
  submittedAt: string,
  overrides: Partial<SubmitAttemptInput> = {},
): SubmitAttemptInput {
  const shown = new Date(Date.parse(submittedAt) - 2_000).toISOString();
  return {
    idempotencyKey: randomUUID(),
    sessionId,
    itemId: "ops-g2-add",
    answer: "42",
    shownAt: shown,
    submittedAt,
    ...overrides,
  };
}

function pieceIds(view: ReturnType<typeof readCompanion>): string[] {
  return [
    ...view.build.completed.flatMap((goal) => goal.pieces),
    ...view.build.active.pieces,
  ].map((piece) => piece.eventId);
}

function busPieceIds(db: DatabaseT.Database, childId: string): string[] {
  const placeholders = PIECE_EVENT_KINDS.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id FROM qualifying_events
       WHERE child_id = ? AND kind IN (${placeholders})
       ORDER BY created_at ASC, id ASC`,
    )
    .all(childId, ...PIECE_EVENT_KINDS) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function expectOneActive(view: ReturnType<typeof readCompanion>) {
  expect(view.build.active.active).toBe(true);
  expect(view.build.completed.every((goal) => goal.active === false && goal.complete)).toBe(true);
  expect(view.build.completed.some((goal) => goal.id === view.build.active.id)).toBe(false);
}

function insertPiece(
  db: DatabaseT.Database,
  childId: string,
  kind: (typeof PIECE_EVENT_KINDS)[number],
  createdAt: string,
  source: string | null = null,
) {
  db.prepare(
    `INSERT INTO qualifying_events (
       id, child_id, kind, idempotency_key, attempt_id, session_id, skill,
       local_day, qualifies, payload_json, created_at
     ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?, ?)`,
  ).run(
    randomUUID(),
    childId,
    kind,
    `${kind}:${createdAt}:${randomUUID()}`,
    kind === "BadgeMilestone" ? "adding two-digit numbers" : null,
    "2026-06-15",
    JSON.stringify(source ? { source, band: "Got it" } : { band: "Got it" }),
    createdAt,
  );
}

describe("build goal projection", () => {
  it("keeps one active goal and places only bus pieces", () => {
    const piece = (index: number): ProjectedPiece => ({
      eventId: `event-${index}`,
      kind: "BuildPieceUnlock",
      role: "build",
      copyKey: "piece.build",
      skill: null,
      localDay: "2026-06-15",
      createdAt: `2026-06-15T00:00:0${index}.000Z`,
    });
    const empty = projectBuildGoalFromPieces([]);
    expect(empty.active.id).toBe(BUILD_GOALS[0].id);
    expect(empty.active.pieces).toEqual([]);
    expect(empty.active.complete).toBe(false);
    expect(empty.completed).toEqual([]);

    const firstFull = projectBuildGoalFromPieces([0, 1, 2].map(piece));
    expect(firstFull.completed.map((goal) => goal.id)).toEqual([BUILD_GOALS[0].id]);
    expect(firstFull.active.id).toBe(BUILD_GOALS[1].id);
    expect(firstFull.active.pieces).toEqual([]);

    const total = BUILD_GOALS.reduce((sum, goal) => sum + goal.pieceTarget, 0);
    const overflow = projectBuildGoalFromPieces(
      Array.from({ length: total + 1 }, (_, index) => piece(index)),
    );
    expect(overflow.completed).toHaveLength(BUILD_GOALS.length - 1);
    expect(overflow.active.id).toBe(BUILD_GOALS[BUILD_GOALS.length - 1].id);
    expect(overflow.active.complete).toBe(true);
    expect(overflow.active.pieces).toHaveLength(BUILD_GOALS[BUILD_GOALS.length - 1].pieceTarget + 1);
    const placed = [...overflow.completed.flatMap((goal) => goal.pieces), ...overflow.active.pieces];
    expect(new Set(placed.map((item) => item.eventId)).size).toBe(total + 1);
  });

  it("projects a got-it session onto the first goal and leaves the next one active", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const when = "2026-06-15T18:00:00.000Z";
    let tier: CelebrationTier = "none";
    for (let index = 0; index < 3; index += 1) {
      const result = submitAttempt(
        db,
        guardian.id,
        child.id,
        tryInput(session.sessionId, when, { idempotencyKey: `got-it-${index}` }),
        { now: when },
      );
      tier = result.celebrationTier;
      expect(Object.keys(result.clientView).sort()).toEqual([
        "bandLabel",
        "celebrationTier",
        "showConceptChip",
      ]);
    }
    expect(tier).toBe("full");
    endPracticeSession(db, guardian.id, child.id, session.sessionId);
    const view = readCompanion(db, child.id, when);
    expectOneActive(view);
    expect(view.build.completed.map((goal) => goal.id)).toEqual(["pot"]);
    expect(view.build.active).toMatchObject({
      id: "sunny-spot",
      complete: false,
      pieces: [],
    });
    expect(view.build.completed[0].pieces.map((piece) => piece.role)).toEqual([
      "badge",
      "level",
      "build",
    ]);
    expect(view.badges).toEqual([
      expect.objectContaining({
        skill: "adding two-digit numbers",
        band: "Got it",
        localDay: "2026-06-15",
      }),
    ]);
    expect(pieceIds(view).sort()).toEqual(busPieceIds(db, child.id).sort());
    expect(projectBadges(db, child.id)).toHaveLength(1);
    expect(JSON.stringify(view)).not.toMatch(/score|confidence|xpAmount|percent|judgment|judgement/i);
    expect(view).not.toHaveProperty("xp");
  });

  it("does not grow the build when the same try is replayed", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const when = "2026-06-15T18:00:00.000Z";
    const input = tryInput(session.sessionId, when, { idempotencyKey: "once-only" });
    submitAttempt(db, guardian.id, child.id, input, { now: when });
    const before = readCompanion(db, child.id, when);
    submitAttempt(db, guardian.id, child.id, { ...input, answer: "0" }, { now: when });
    const after = readCompanion(db, child.id, when);
    expect(pieceIds(after)).toEqual(pieceIds(before));
    expect(after.badges.map((badge) => badge.eventId)).toEqual(
      before.badges.map((badge) => badge.eventId),
    );
  });

  it("places a hot-streak unlock on the next goal without a second ledger", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const firstDay = "2026-06-15T18:00:00.000Z";
    for (let index = 0; index < 3; index += 1) {
      submitAttempt(
        db,
        guardian.id,
        child.id,
        tryInput(session.sessionId, firstDay, { idempotencyKey: `day-one-${index}` }),
        { now: firstDay },
      );
    }
    endPracticeSession(db, guardian.id, child.id, session.sessionId);
    choosePracticeLane(db, guardian.id, child.id, session.sessionId, "recommended");

    const restart = "2026-06-17T16:00:00.000Z";
    const restarted = startPracticeSession(db, guardian.id, child.id);
    submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(restarted.sessionId, restart, { idempotencyKey: "restart-warm" }),
      { now: restart },
    );
    expect(readCompanion(db, child.id, restart).build.active.pieces).toEqual([]);

    const hotDay = "2026-06-18T18:00:00.000Z";
    submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(restarted.sessionId, hotDay, { idempotencyKey: "streak-hot" }),
      { now: hotDay },
    );
    const view = readCompanion(db, child.id, hotDay);
    expect(view.streak.state).toBe("hot");
    expect(view.streak.recovery).toBeNull();
    expect(view.streak.copyKey).toBe("streak.hot");
    expect(view.build.active.pieces).toEqual([
      expect.objectContaining({ role: "streak", kind: "BuildPieceUnlock", copyKey: "piece.streak" }),
    ]);
    expect(pieceIds(view).sort()).toEqual(busPieceIds(db, child.id).sort());
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name).sort()).toEqual([
      "attempts",
      "boundary_events",
      "children",
      "consents",
      "guardians",
      "learner_progress",
      "learner_skill_state",
      "practice_sessions",
      "qualifying_events",
      "sessions",
      "xp_events",
    ]);
  });

  it("shows a bus badge that was not copied into another table", () => {
    const db = tempDb();
    const { child } = grantedChild(db);
    const beforeXp = (
      db.prepare(`SELECT COUNT(*) AS count FROM xp_events`).get() as { count: number }
    ).count;
    insertPiece(db, child.id, "BadgeMilestone", "2026-06-15T18:00:01.000Z");
    const view = readCompanion(db, child.id, "2026-06-15T18:00:02.000Z");
    expect(view.badges).toHaveLength(1);
    expect(view.build.active.pieces).toEqual([
      expect.objectContaining({ kind: "BadgeMilestone", role: "badge" }),
    ]);
    expect(
      (db.prepare(`SELECT COUNT(*) AS count FROM xp_events`).get() as { count: number }).count,
    ).toBe(beforeXp);
    expect(projectBuildGoal(db, child.id).active.pieces).toHaveLength(1);
  });

  it("keeps review tries off the build and the badge screen", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const when = "2026-06-15T18:00:00.000Z";
    submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, when, { answer: "   ", idempotencyKey: "blank-review" }),
      { now: when },
    );
    endPracticeSession(db, guardian.id, child.id, session.sessionId);
    choosePracticeLane(db, guardian.id, child.id, session.sessionId, "review");
    const review = startPracticeSession(db, guardian.id, child.id);
    for (let index = 0; index < 3; index += 1) {
      submitAttempt(
        db,
        guardian.id,
        child.id,
        tryInput(review.sessionId, when, { idempotencyKey: `review-${index}` }),
        { now: when },
      );
    }
    endPracticeSession(db, guardian.id, child.id, review.sessionId);
    const view = readCompanion(db, child.id, when);
    expect(view.badges).toEqual([]);
    expect(view.build.active.id).toBe("pot");
    expect(view.build.active.pieces).toEqual([]);
    expect(view.build.completed).toEqual([]);
  });
});

describe("ember recovery", () => {
  it("offers recovery only while the flame is an ember", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const fresh = readCompanion(db, child.id, "2026-06-15T18:00:00.000Z");
    expect(fresh.streak).toMatchObject({
      state: "dormant",
      copyKey: "streak.dormant",
      recovery: null,
    });

    const monday = "2026-06-15T18:00:00.000Z";
    submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, monday, { idempotencyKey: "warm-day" }),
      { now: monday },
    );
    const warm = readCompanion(db, child.id, monday);
    expect(warm.streak.state).toBe("warm");
    expect(warm.streak.recovery).toBeNull();
    expect(INTERFACE_COPY[warm.streak.copyKey]).toMatch(/warm/i);

    const emberAt = "2026-06-16T16:00:00.000Z";
    const ember = readCompanion(db, child.id, emberAt);
    expect(ember.streak.state).toBe("ember");
    expect(ember.streak.recovery).toEqual({
      copyKey: "streak.ember.recover",
      detailKey: "streak.ember.recover.detail",
    });
    expect(INTERFACE_COPY[ember.streak.recovery!.copyKey]).toMatch(/practice today/i);
    expect(INTERFACE_COPY[ember.streak.recovery!.detailKey].length).toBeGreaterThan(0);

    const dormantAt = "2026-06-17T16:00:00.000Z";
    const dormant = readCompanion(db, child.id, dormantAt);
    expect(dormant.streak.state).toBe("dormant");
    expect(dormant.streak.recovery).toBeNull();
    expect(dormant.streak.lastQualifyingDay).toBe("2026-06-15");
  });
});

describe("locked surfaces", () => {
  it("leaves the child home and parent home free of a progress ledger", () => {
    const db = tempDb();
    const guardian = createGuardian(db, {
      email: "parent@example.com",
      password: "correct-horse",
    });
    const child = createChild(db, guardian.id, { displayName: "Ava" });
    const home = getChildHome(db, guardian.id, child.id);
    expect(Object.keys(home).sort()).toEqual(["child", "practiceAllowed", "reason"]);
    const parent = getParentHome(db, guardian.id);
    expect(parent.narrative).toBe(PARENT_HOME_NARRATIVE);
    expect(Object.keys(parent.children[0]).sort()).toEqual([
      "consentStatus",
      "displayName",
      "id",
      "practiceAllowed",
      "reason",
      "timezone",
    ]);
    expect(parent.children[0]).not.toHaveProperty("streak");
    expect(parent.children[0]).not.toHaveProperty("badges");
  });
});
