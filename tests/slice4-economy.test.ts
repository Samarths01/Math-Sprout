import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type DatabaseT from "better-sqlite3";
import {
  SPAM_MAX_IN_WINDOW,
  TOO_FAST_MS,
  XP_AMOUNT,
  type AttemptResult,
  type CelebrationTier,
} from "@/lib/attempt-contract";
import { readAttemptLog } from "@/lib/attempt-log";
import { startPracticeSession, submitAttempt, type SubmitAttemptInput } from "@/lib/attempts";
import { choosePracticeLane, endPracticeSession } from "@/lib/boundary";
import { openDatabase } from "@/lib/db";
import { POLICY_VERSION } from "@/lib/policy";
import { createChild, createGuardian, setConsent } from "@/lib/domain";
import { REVIEW_SESSIONS_PER_WEEK } from "@/lib/economy-config";
import {
  emberExpiryForQualifyingDay,
  localDate,
  startOfLocalDay,
} from "@/lib/local-time";
import {
  applyMintGate,
  assertCelebrationBacked,
  deriveCelebration,
  mintLevelUpSlight,
  observeStreak,
  readStreak,
  type PlannedMint,
} from "@/lib/qualifying-bus";
import { coolStreak, emptyStreak, heatStreak } from "@/lib/streak";

const cleanups: Array<() => void> = [];

function tempDb(): DatabaseT.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-slice4-"));
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

function grantedChild(
  db: DatabaseT.Database,
  timezone = "America/Los_Angeles",
  email = "parent@example.com",
) {
  const guardian = createGuardian(db, {
    email,
    password: "correct-horse",
    timezone,
  });
  const child = createChild(db, guardian.id, { displayName: "Ava", timezone });
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

function countKind(db: DatabaseT.Database, kind: string, childId?: string): number {
  const row = db
    .prepare(
      childId
        ? `SELECT COUNT(*) AS count FROM qualifying_events WHERE kind = ? AND child_id = ?`
        : `SELECT COUNT(*) AS count FROM qualifying_events WHERE kind = ?`,
    )
    .get(...(childId ? [kind, childId] : [kind])) as { count: number };
  return row.count;
}

function xpCount(db: DatabaseT.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM xp_events`).get() as { count: number }).count;
}

function fullXpCount(db: DatabaseT.Database): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM xp_events WHERE amount = ?`).get(XP_AMOUNT.full) as {
      count: number;
    }
  ).count;
}

function expectClientViewSealed(result: AttemptResult) {
  expect(Object.keys(result.clientView).sort()).toEqual([
    "bandLabel",
    "celebrationTier",
    "showConceptChip",
  ]);
  expect(JSON.stringify(result.clientView)).not.toMatch(
    /%|score|confidence|percent|judgment|judgement/i,
  );
  expect(result.clientView).not.toHaveProperty("score");
  expect(result.clientView).not.toHaveProperty("confidence");
  expect(result).not.toHaveProperty("policyVersion");
}

function expectPolicyStamp(
  db: DatabaseT.Database,
  attemptId: string,
  sessionId: string,
) {
  const attempt = db
    .prepare(`SELECT policy_version FROM attempts WHERE id = ?`)
    .get(attemptId) as { policy_version: string };
  const session = db
    .prepare(`SELECT policy_version FROM practice_sessions WHERE id = ?`)
    .get(sessionId) as { policy_version: string };
  expect(attempt.policy_version).toBe(POLICY_VERSION);
  expect(session.policy_version).toBe("rules-v0");
  const log = readAttemptLog(db, attemptId);
  expect(log.policyVersion).toBe("rules-v0");
  expect(JSON.stringify(log.clientView)).not.toMatch(
    /%|score|confidence|percent|judgment|judgement/i,
  );
  expect(log).not.toHaveProperty("score");
  expect(log).not.toHaveProperty("confidence");
}

const honest = (tier: "quietXp" | "full"): PlannedMint => ({
  kind: "HonestAttempt",
  idempotencyKey: "attempt-key-1:HonestAttempt",
  xpAmount: XP_AMOUNT[tier],
  celebrationTier: tier,
  qualifies: tier === "full",
  skill: "adding two-digit numbers",
  localDay: "2026-06-15",
  payload: { practiceLane: "recommended", reduced: tier !== "full", reason: "careful_correct" },
});

describe("mint gate and celebration", () => {
  it("derives celebration from the mints and fails closed without a credit", () => {
    expect(deriveCelebration([honest("full")], "celebrate")).toBe("full");
    expect(deriveCelebration([honest("quietXp")], "celebrate")).toBe("quietXp");
    expect(deriveCelebration([], "celebrate")).toBe("none");
    expect(() => deriveCelebration([honest("full")], "review")).toThrow(/cannot mint full/);
    expect(() =>
      assertCelebrationBacked({
        tier: "full",
        xpCount: 0,
        integrityLane: "celebrate",
        practiceLane: "recommended",
      }),
    ).toThrow(/requires a mint/);
    expect(() =>
      assertCelebrationBacked({
        tier: "full",
        xpCount: 1,
        integrityLane: "review",
        practiceLane: "recommended",
      }),
    ).toThrow(/cannot mint full/);
    expect(() =>
      assertCelebrationBacked({
        tier: "quietXp",
        xpCount: 0,
        integrityLane: "celebrate",
        practiceLane: "recommended",
      }),
    ).toThrow(/requires a mint/);
  });

  it("keeps review to a reduced HonestAttempt and blocks the weekly cap", () => {
    const gated = applyMintGate(
      [
        honest("full"),
        { ...honest("full"), kind: "LevelUpSlight", xpAmount: 0, celebrationTier: null },
        { ...honest("full"), kind: "BadgeMilestone", xpAmount: 0, celebrationTier: null },
        { ...honest("full"), kind: "BuildPieceUnlock", xpAmount: 0, celebrationTier: null },
        { ...honest("full"), kind: "QualifyingPracticeDay", xpAmount: 0, celebrationTier: null },
      ],
      { practiceLane: "review", integrityLane: "celebrate", reviewSessionsThisWeek: 1 },
    );
    expect(gated.map((mint) => mint.kind)).toEqual(["HonestAttempt"]);
    expect(gated[0]).toMatchObject({
      celebrationTier: "quietXp",
      xpAmount: XP_AMOUNT.quietXp,
    });
    expect(
      applyMintGate([honest("full")], {
        practiceLane: "review",
        integrityLane: "celebrate",
        reviewSessionsThisWeek: REVIEW_SESSIONS_PER_WEEK + 1,
      }),
    ).toEqual([]);
    expect(deriveCelebration(gated, "celebrate")).toBe("quietXp");
  });
});

describe("streak clock", () => {
  it("heats only one step per new qualifying day and cools through ember", () => {
    const monday = "2026-06-15";
    const tuesday = "2026-06-16";
    const expiry = emberExpiryForQualifyingDay(monday, "America/Los_Angeles");
    const warmed = heatStreak(
      coolStreak(emptyStreak(), monday, "2026-06-15T18:00:00.000Z"),
      monday,
      expiry,
    );
    expect(warmed.state).toBe("warm");
    const duringEmber = "2026-06-16T16:00:00.000Z";
    expect(duringEmber < expiry).toBe(true);
    const ember = coolStreak(warmed, tuesday, duringEmber);
    expect(ember.state).toBe("ember");
    const hot = heatStreak(ember, tuesday, emberExpiryForQualifyingDay(tuesday, "America/Los_Angeles"));
    expect(hot.state).toBe("hot");
    expect(heatStreak(hot, tuesday, hot.emberExpiresAt ?? expiry)).toEqual(hot);
    const later = coolStreak(hot, "2026-06-18", "2026-06-18T18:00:00.000Z");
    expect(later.state).toBe("dormant");
    expect(later.lastQualifyingDay).toBe(tuesday);
  });
});

describe("qualifying event bus", () => {
  it("mints XP only from a bus event in the same transaction", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const when = "2026-06-15T18:00:00.000Z";
    const result = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, when, { idempotencyKey: "bus-key-0001" }),
      { now: when },
    );
    const credit = db
      .prepare(
        `SELECT e.id, e.amount, e.celebration_tier, e.qualifying_event_id, q.kind, q.idempotency_key
         FROM xp_events e JOIN qualifying_events q ON q.id = e.qualifying_event_id
         WHERE e.attempt_id = ?`,
      )
      .get(result.attemptId) as {
      id: string;
      amount: number;
      celebration_tier: CelebrationTier;
      qualifying_event_id: string;
      kind: string;
      idempotency_key: string;
    };
    expect(result.celebrationTier).toBe("full");
    expect(result.eventIds).toEqual([credit.id]);
    expect(credit.amount).toBe(XP_AMOUNT.full);
    expect(credit.celebration_tier).toBe("full");
    expect(credit.kind).toBe("HonestAttempt");
    expect(credit.idempotency_key).toBe("bus-key-0001:HonestAttempt");
    expect(countKind(db, "QualifyingPracticeDay")).toBe(1);
    expect(readStreak(db, child.id).state).toBe("warm");

    expect(() =>
      db
        .prepare(
          `INSERT INTO xp_events (id, attempt_id, child_id, amount, celebration_tier, minted_at)
           VALUES (?, ?, ?, 1, 'quietXp', ?)`,
        )
        .run(randomUUID(), result.attemptId, child.id, when),
    ).toThrow(/qualifying event|NOT NULL|UNIQUE/i);
    expect(() =>
      db.prepare(`UPDATE qualifying_events SET kind = 'BadgeMilestone'`).run(),
    ).toThrow(/append-only/);
  });

  it("does not mint a second credit or qualifying day when the attempt is replayed", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const when = "2026-06-15T18:00:00.000Z";
    const firstInput = tryInput(session.sessionId, when, { idempotencyKey: "replay-key-01" });
    const first = submitAttempt(db, guardian.id, child.id, firstInput, { now: when });
    const again = submitAttempt(db, guardian.id, child.id, {
      ...firstInput,
      answer: "0",
      submittedAt: "2026-06-16T18:00:00.000Z",
    }, { now: "2026-06-16T18:00:00.000Z" });
    const second = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, when, { idempotencyKey: "replay-key-02" }),
      { now: when },
    );

    expect(again.replayed).toBe(true);
    expect(again.eventIds).toEqual(first.eventIds);
    expect(again.xpAmount).toBe(first.xpAmount);
    expect(xpCount(db)).toBe(2);
    expect(countKind(db, "HonestAttempt")).toBe(2);
    expect(countKind(db, "QualifyingPracticeDay")).toBe(1);
    expect(second.celebrationTier).toBe("full");
    expect(readStreak(db, child.id)).toMatchObject({
      state: "warm",
      lastQualifyingDay: "2026-06-15",
    });
  });

  it("fails closed when the credit insert aborts", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    db.exec(`
      CREATE TRIGGER fail_bus_mint BEFORE INSERT ON xp_events
      BEGIN
        SELECT RAISE(ABORT, 'mint failed');
      END;
    `);
    expect(() =>
      submitAttempt(db, guardian.id, child.id, tryInput(session.sessionId, "2026-06-15T18:00:00.000Z")),
    ).toThrow(/mint failed/);
    expect(xpCount(db)).toBe(0);
    expect(countKind(db, "HonestAttempt")).toBe(0);
    expect(countKind(db, "QualifyingPracticeDay")).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS count FROM attempts`).get() as { count: number }).count,
    ).toBe(0);
  });
});

describe("review dual-cap", () => {
  it("exposes remaining review sets and enforces the cap at the mint", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const when = "2026-06-15T18:00:00.000Z";
    submitAttempt(db, guardian.id, child.id, tryInput(session.sessionId, when), { now: when });
    const firstBoundary = endPracticeSession(db, guardian.id, child.id, session.sessionId);
    expect(firstBoundary.reviewSessionsRemaining).toBe(REVIEW_SESSIONS_PER_WEEK);
    expect(firstBoundary.options.find((option) => option.lane === "review")).toMatchObject({
      available: true,
      sessionsRemaining: REVIEW_SESSIONS_PER_WEEK,
    });

    let current = session.sessionId;
    choosePracticeLane(db, guardian.id, child.id, current, "review");
    for (let index = 0; index < REVIEW_SESSIONS_PER_WEEK; index += 1) {
      const review = startPracticeSession(db, guardian.id, child.id);
      expect(review.lane).toBe("review");
      const minted = submitAttempt(
        db,
        guardian.id,
        child.id,
        tryInput(review.sessionId, when, { idempotencyKey: `review-cap-${index}` }),
        { now: when },
      );
      expect(minted.celebrationTier).toBe("quietXp");
      expect(minted.xpAmount).toBe(XP_AMOUNT.quietXp);
      expect(["quietXp", "none"]).toContain(minted.celebrationTier);
      const ended = endPracticeSession(db, guardian.id, child.id, review.sessionId);
      expect(ended.levelUpSlight).toBe(false);
      current = review.sessionId;
      if (index < REVIEW_SESSIONS_PER_WEEK - 1) {
        choosePracticeLane(db, guardian.id, child.id, current, "review");
      }
    }

    const capped = endPracticeSession(db, guardian.id, child.id, current);
    expect(capped.reviewSessionsRemaining).toBe(0);
    expect(capped.options.find((option) => option.lane === "review")?.available).toBe(false);
    expect(() => choosePracticeLane(db, guardian.id, child.id, current, "review")).toThrow(
      /used up/,
    );
    choosePracticeLane(db, guardian.id, child.id, current, "recommended");
    db.prepare(`UPDATE learner_progress SET next_lane = 'review' WHERE child_id = ?`).run(
      child.id,
    );

    const extra = startPracticeSession(db, guardian.id, child.id);
    expect(extra.lane).toBe("review");
    const blocked = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(extra.sessionId, when, { idempotencyKey: "review-cap-blocked" }),
      { now: when },
    );
    expect(blocked.celebrationTier).toBe("none");
    expect(blocked.xpAmount).toBe(0);
    expect(blocked.eventIds).toEqual([]);
    expect(blocked.clientView.celebrationTier).toBe("none");
  });

  it("does not mint LevelUpSlight, a badge, or a build piece from review", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const when = "2026-06-15T18:00:00.000Z";
    submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, when, { answer: "   " }),
      { now: when },
    );
    endPracticeSession(db, guardian.id, child.id, session.sessionId);
    choosePracticeLane(db, guardian.id, child.id, session.sessionId, "review");
    const review = startPracticeSession(db, guardian.id, child.id);
    for (let index = 0; index < 3; index += 1) {
      const result = submitAttempt(
        db,
        guardian.id,
        child.id,
        tryInput(review.sessionId, when, { idempotencyKey: `review-kind-${index}` }),
        { now: when },
      );
      expect(result.celebrationTier).toBe("quietXp");
    }
    expect(mintLevelUpSlight(db, {
      childId: child.id,
      sessionId: review.sessionId,
      practiceLane: "review",
      createdAt: when,
      timeZone: "America/Los_Angeles",
    })).toBe(false);
    endPracticeSession(db, guardian.id, child.id, review.sessionId);
    for (const kind of ["LevelUpSlight", "BadgeMilestone", "BuildPieceUnlock", "QualifyingPracticeDay"]) {
      expect(countKind(db, kind, child.id)).toBe(0);
    }
    expect(countKind(db, "HonestAttempt", child.id)).toBe(3);
    expect(readStreak(db, child.id).state).toBe("dormant");
    expect(readStreak(db, child.id).lastQualifyingDay).toBeNull();
  });
});

describe("qualifying practice day", () => {
  it("uses the child timezone and heats Hot only on a new qualifying day", () => {
    const db = tempDb();
    const guardian = createGuardian(db, {
      email: "parent@example.com",
      password: "correct-horse",
      timezone: "America/Los_Angeles",
    });
    const losAngeles = createChild(db, guardian.id, {
      displayName: "Ava",
      timezone: "America/Los_Angeles",
    });
    const auckland = createChild(db, guardian.id, {
      displayName: "Nico",
      timezone: "Pacific/Auckland",
    });
    setConsent(db, guardian.id, losAngeles.id, "grant");
    setConsent(db, guardian.id, auckland.id, "grant");
    const when = "2026-06-15T18:00:00.000Z";
    expect(localDate(when, "America/Los_Angeles")).toBe("2026-06-15");
    expect(localDate(when, "Pacific/Auckland")).toBe("2026-06-16");
    expect(startOfLocalDay("2026-06-17", "America/Los_Angeles").toISOString()).toBe(
      "2026-06-17T07:00:00.000Z",
    );

    const laSession = startPracticeSession(db, guardian.id, losAngeles.id);
    submitAttempt(db, guardian.id, losAngeles.id, tryInput(laSession.sessionId, when), { now: when });
    const nzSession = startPracticeSession(db, guardian.id, auckland.id);
    submitAttempt(db, guardian.id, auckland.id, tryInput(nzSession.sessionId, when), { now: when });
    expect(readStreak(db, losAngeles.id).lastQualifyingDay).toBe("2026-06-15");
    expect(readStreak(db, auckland.id).lastQualifyingDay).toBe("2026-06-16");
    expect(readStreak(db, losAngeles.id).state).toBe("warm");
    expect(readStreak(db, losAngeles.id).emberExpiresAt).toBe(
      emberExpiryForQualifyingDay("2026-06-15", "America/Los_Angeles"),
    );

    const emberAt = "2026-06-16T16:00:00.000Z";
    expect(observeStreak(db, losAngeles.id, "America/Los_Angeles", emberAt).state).toBe("ember");
    expect(readStreak(db, losAngeles.id).lastQualifyingDay).toBe("2026-06-15");
    const afterEmber = "2026-06-17T16:00:00.000Z";
    expect(observeStreak(db, losAngeles.id, "America/Los_Angeles", afterEmber).state).toBe(
      "dormant",
    );

    const restarted = submitAttempt(
      db,
      guardian.id,
      losAngeles.id,
      tryInput(laSession.sessionId, afterEmber, { idempotencyKey: "restart-day-01" }),
      { now: afterEmber },
    );
    expect(restarted.celebrationTier).toBe("full");
    expect(readStreak(db, losAngeles.id).state).toBe("warm");

    const nextDay = "2026-06-18T18:00:00.000Z";
    submitAttempt(
      db,
      guardian.id,
      losAngeles.id,
      tryInput(laSession.sessionId, nextDay, { idempotencyKey: "hot-day-0002" }),
      { now: nextDay },
    );
    expect(readStreak(db, losAngeles.id)).toMatchObject({
      state: "hot",
      lastQualifyingDay: "2026-06-18",
    });
    expect(countKind(db, "BuildPieceUnlock", losAngeles.id)).toBe(1);
    expect(countKind(db, "QualifyingPracticeDay", losAngeles.id)).toBe(3);

    submitAttempt(
      db,
      guardian.id,
      losAngeles.id,
      tryInput(laSession.sessionId, nextDay, { idempotencyKey: "hot-day-0003" }),
      { now: nextDay },
    );
    expect(countKind(db, "QualifyingPracticeDay", losAngeles.id)).toBe(3);
    expect(countKind(db, "BuildPieceUnlock", losAngeles.id)).toBe(1);
    expect(readStreak(db, losAngeles.id).state).toBe("hot");
  });

  it("does not heat on an empty or too-fast try", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const when = "2026-06-15T18:00:00.000Z";
    const blank = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, when, { answer: "   ", idempotencyKey: "blank-day-001" }),
      { now: when },
    );
    const rushed = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, when, {
        idempotencyKey: "fast-day-0001",
        shownAt: when,
        submittedAt: new Date(Date.parse(when) + 100).toISOString(),
      }),
      { now: when },
    );
    expect(blank.celebrationTier).toBe("none");
    expect(rushed.celebrationTier).toBe("none");
    expect(countKind(db, "QualifyingPracticeDay")).toBe(0);
    expect(countKind(db, "HonestAttempt")).toBe(0);
    expect(readStreak(db, child.id)).toEqual({
      state: "dormant",
      emberExpiresAt: null,
      lastQualifyingDay: null,
    });
  });

  it("mints a badge and a level-up piece from recommended evidence, once", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const when = "2026-06-15T18:00:00.000Z";
    for (let index = 0; index < 3; index += 1) {
      submitAttempt(
        db,
        guardian.id,
        child.id,
        tryInput(session.sessionId, when, { idempotencyKey: `got-it-key-${index}` }),
        { now: when },
      );
    }
    endPracticeSession(db, guardian.id, child.id, session.sessionId);
    endPracticeSession(db, guardian.id, child.id, session.sessionId);
    expect(countKind(db, "BadgeMilestone")).toBe(1);
    expect(countKind(db, "LevelUpSlight")).toBe(1);
    expect(countKind(db, "BuildPieceUnlock")).toBe(1);
    expect(countKind(db, "ConceptProgressTick")).toBe(3);
    expect(countKind(db, "MasteryBandTransition")).toBe(2);
    expect(countKind(db, "QualifyingPracticeDay")).toBe(1);
    expect(
      (db.prepare(`SELECT COUNT(*) AS count FROM boundary_events`).get() as { count: number })
        .count,
    ).toBe(1);
  });
});

describe("slice 3 economy upgrade", () => {
  it("adds the bus and streak columns without dropping the old credit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-slice4-upgrade-"));
    const filename = path.join(dir, "old.sqlite");
    const raw = new Database(filename);
    raw.exec(`
      CREATE TABLE learner_progress (
        child_id TEXT PRIMARY KEY,
        next_lane TEXT NOT NULL DEFAULT 'recommended',
        difficulty_step INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      INSERT INTO learner_progress (child_id, next_lane, difficulty_step, updated_at)
      VALUES ('child-old', 'recommended', 1, '2026-01-01T00:00:00.000Z');
      CREATE TABLE xp_events (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL UNIQUE,
        child_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        celebration_tier TEXT NOT NULL,
        minted_at TEXT NOT NULL
      );
      INSERT INTO xp_events (id, attempt_id, child_id, amount, celebration_tier, minted_at)
      VALUES ('xp-old', 'attempt-old', 'child-old', 5, 'full', '2026-01-01T00:00:00.000Z');
    `);
    raw.close();
    const db = openDatabase(filename);
    cleanups.push(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const progress = db.pragma("table_info(learner_progress)") as Array<{ name: string }>;
    expect(progress.map((column) => column.name)).toEqual(
      expect.arrayContaining(["streak_state", "ember_expires_at", "last_qualifying_day"]),
    );
    const stored = db
      .prepare(
        `SELECT streak_state, difficulty_step FROM learner_progress WHERE child_id = ?`,
      )
      .get("child-old") as { streak_state: string; difficulty_step: number };
    expect(stored).toEqual({ streak_state: "dormant", difficulty_step: 1 });
    const xp = db.pragma("table_info(xp_events)") as Array<{ name: string }>;
    expect(xp.map((column) => column.name)).toContain("qualifying_event_id");
    const names = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'qualifying_events'`)
        .all() as Array<{ name: string }>
    ).map((table) => table.name);
    expect(names).toEqual(["qualifying_events"]);
  });

  it("backfills policy_version on sessions and attempts that predate the column", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-policy-upgrade-"));
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
    const session = db
      .prepare(`SELECT policy_version FROM practice_sessions WHERE id = ?`)
      .get("sess-old") as { policy_version: string };
    const attempt = db
      .prepare(`SELECT policy_version FROM attempts WHERE id = ?`)
      .get("attempt-old") as { policy_version: string };
    expect(session.policy_version).toBe(POLICY_VERSION);
    expect(attempt.policy_version).toBe("rules-v0");
  });
});

describe("architecture §21 integrity gate", () => {
  const when = "2026-06-15T18:00:00.000Z";

  function rewardSnapshot(db: DatabaseT.Database, childId: string) {
    return {
      fullXp: fullXpCount(db),
      badge: countKind(db, "BadgeMilestone", childId),
      piece: countKind(db, "BuildPieceUnlock", childId),
    };
  }

  it("does not mint full XP, a badge, or a build piece for an empty answer", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const result = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, when, { answer: "   " }),
      { now: when },
    );
    expect(result.flags).toContain("empty_answer");
    expect(result.lane).toBe("review");
    expect(result.celebrationTier).toBe("none");
    expect(result.xpAmount).toBe(0);
    expect(result.eventIds).toEqual([]);
    expectClientViewSealed(result);
    expectPolicyStamp(db, result.attemptId, session.sessionId);
    expect(rewardSnapshot(db, child.id)).toEqual({ fullXp: 0, badge: 0, piece: 0 });
  });

  it("does not mint full XP, a badge, or a build piece for a too-fast answer", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const submittedAt = when;
    const shownAt = new Date(Date.parse(submittedAt) - (TOO_FAST_MS - 1)).toISOString();
    const result = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, submittedAt, { answer: "42", shownAt, submittedAt }),
      { now: when },
    );
    expect(result.correct).toBe(true);
    expect(result.flags).toContain("too_fast");
    expect(result.celebrationTier).toBe("none");
    expect(result.xpAmount).toBe(0);
    expectClientViewSealed(result);
    expectPolicyStamp(db, result.attemptId, session.sessionId);
    expect(rewardSnapshot(db, child.id)).toEqual({ fullXp: 0, badge: 0, piece: 0 });
  });

  it("does not mint a second full XP, badge, or build piece for a duplicate key", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const firstInput = tryInput(session.sessionId, when, { idempotencyKey: "dup-key-0001" });
    const first = submitAttempt(db, guardian.id, child.id, firstInput, { now: when });
    expect(first.celebrationTier).toBe("full");
    expect(first.xpAmount).toBe(XP_AMOUNT.full);
    const before = rewardSnapshot(db, child.id);
    expect(before.fullXp).toBe(1);
    const replay = submitAttempt(
      db,
      guardian.id,
      child.id,
      { ...firstInput, answer: "0" },
      { now: when },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.attemptId).toBe(first.attemptId);
    expect(replay.eventIds).toEqual(first.eventIds);
    expect(replay.clientView).toEqual(first.clientView);
    expectClientViewSealed(replay);
    expectPolicyStamp(db, replay.attemptId, session.sessionId);
    expect(rewardSnapshot(db, child.id)).toEqual(before);
    expect(xpCount(db)).toBe(1);
  });

  it("keeps identical spam off full XP, badges, and build pieces", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const base = Date.parse(when);
    const answer = "42";
    for (let index = 0; index < SPAM_MAX_IN_WINDOW; index += 1) {
      const submittedAt = new Date(base + index * 1_000).toISOString();
      submitAttempt(
        db,
        guardian.id,
        child.id,
        tryInput(session.sessionId, submittedAt, {
          idempotencyKey: `spam-pace-${index}`,
          answer,
        }),
        { now: submittedAt },
      );
    }
    const before = rewardSnapshot(db, child.id);
    const submittedAt = new Date(base + SPAM_MAX_IN_WINDOW * 1_000).toISOString();
    const spam = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, submittedAt, {
        idempotencyKey: "spam-identical",
        answer,
      }),
      { now: submittedAt },
    );
    expect(spam.flags).toContain("spam_window");
    expect(spam.lane).toBe("review");
    expect(spam.celebrationTier).toBe("quietXp");
    expect(spam.xpAmount).toBe(XP_AMOUNT.quietXp);
    expect(spam.celebrationTier).not.toBe("full");
    expectClientViewSealed(spam);
    expectPolicyStamp(db, spam.attemptId, session.sessionId);
    expect(rewardSnapshot(db, child.id)).toEqual(before);
    const kinds = db
      .prepare(
        `SELECT kind FROM qualifying_events WHERE attempt_id = ? ORDER BY kind ASC`,
      )
      .all(spam.attemptId) as Array<{ kind: string }>;
    expect(kinds.map((row) => row.kind)).toEqual(["HonestAttempt"]);
    const answers = db
      .prepare(`SELECT answer FROM attempts WHERE child_id = ?`)
      .all(child.id) as Array<{ answer: string }>;
    expect(new Set(answers.map((row) => row.answer))).toEqual(new Set([answer]));
  });
});
