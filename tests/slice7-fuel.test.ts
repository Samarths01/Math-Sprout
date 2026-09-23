import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type Database from "better-sqlite3";
import { XP_AMOUNT } from "@/lib/attempt-contract";
import { startPracticeSession, submitAttempt, type SubmitAttemptInput } from "@/lib/attempts";
import { choosePracticeLane, endPracticeSession } from "@/lib/boundary";
import { CompanionState } from "@/components/companion-state";
import { FuelMoment } from "@/components/fuel-moment";
import { ParentOneBreathCard } from "@/components/parent-one-breath";
import { readCompanion } from "@/lib/companion";
import { openDatabase } from "@/lib/db";
import { createChild, createGuardian, setConsent } from "@/lib/domain";
import { accruedXp, projectHeat, readKidFuel } from "@/lib/fuel";
import { fuelMotion, xpBacked } from "@/lib/fuel-motion";
import { MasteryEstimator } from "@/lib/mastery";
import { PARENT_SUMMARY_KEYS, readParentSummary } from "@/lib/parent-summary";
import { POLICY_VERSION } from "@/lib/policy";
import { queueDisposition } from "@/lib/practice-gate";
import { assertCelebrationBacked, readStreak } from "@/lib/qualifying-bus";

const cleanups: Array<() => void> = [];

function tempDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-slice7-"));
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

function grantedChild(db: Database.Database) {
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

function countKind(db: Database.Database, kind: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM qualifying_events WHERE kind = ?`).get(kind) as {
      count: number;
    }
  ).count;
}

const WHEN = "2026-06-15T18:00:00.000Z";
const NEXT = "2026-06-16T18:00:00.000Z";

describe("qualifying-event fuel", () => {
  it("leaves heat, XP, and pieces unchanged when volume never qualifies", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const before = readKidFuel(db, child.id, child.timezone, WHEN);
    expect(before).toMatchObject({
      accrued: 0,
      pieces: [],
      heat: { state: "dormant", sourceEventId: null, lastQualifyingDay: null },
    });

    for (let index = 0; index < 4; index += 1) {
      const blank = submitAttempt(
        db,
        guardian.id,
        child.id,
        tryInput(session.sessionId, WHEN, {
          answer: "   ",
          idempotencyKey: `blank-volume-${index}`,
        }),
        { now: WHEN },
      );
      expect(blank.fuel).toEqual({ credit: 0, heatEventId: null, pieceEventIds: [] });
      expect(blank.eventIds).toEqual([]);
      expect(blank.xpAmount).toBe(0);
    }
    const rushed = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, WHEN, {
        idempotencyKey: "fast-volume-1",
        shownAt: WHEN,
        submittedAt: new Date(Date.parse(WHEN) + 100).toISOString(),
      }),
      { now: WHEN },
    );
    expect(rushed.celebrationTier).toBe("none");
    expect(rushed.fuel.credit).toBe(0);

    const after = readKidFuel(db, child.id, child.timezone, WHEN);
    expect(after.accrued).toBe(0);
    expect(after.pieces).toEqual([]);
    expect(after.heat.state).toBe("dormant");
    expect(countKind(db, "QualifyingPracticeDay")).toBe(0);
    expect(countKind(db, "BadgeMilestone")).toBe(0);
    expect(countKind(db, "BuildPieceUnlock")).toBe(0);
    expect(readCompanion(db, child.id, WHEN).streak.sourceEventId).toBeNull();
  });

  it("keeps review off badges and build pieces and accrues only a quiet credit", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, WHEN, { answer: "   ", idempotencyKey: "review-gate-blank" }),
      { now: WHEN },
    );
    endPracticeSession(db, guardian.id, child.id, session.sessionId);
    choosePracticeLane(db, guardian.id, child.id, session.sessionId, "review");
    const review = startPracticeSession(db, guardian.id, child.id);
    const before = accruedXp(db, child.id);
    for (let index = 0; index < 4; index += 1) {
      const result = submitAttempt(
        db,
        guardian.id,
        child.id,
        tryInput(review.sessionId, WHEN, { idempotencyKey: `review-fuel-${index}` }),
        { now: WHEN },
      );
      expect(result.celebrationTier).toBe("quietXp");
      expect(result.celebrationTier).not.toBe("full");
      expect(result.fuel.credit).toBe(XP_AMOUNT.quietXp);
      expect(result.fuel.heatEventId).toBeNull();
      expect(result.fuel.pieceEventIds).toEqual([]);
      expect(result.xpAmount).toBe(result.fuel.credit);
    }
    endPracticeSession(db, guardian.id, child.id, review.sessionId);
    expect(accruedXp(db, child.id)).toBe(before + 4 * XP_AMOUNT.quietXp);
    for (const kind of ["BadgeMilestone", "BuildPieceUnlock", "LevelUpSlight", "QualifyingPracticeDay"]) {
      expect(countKind(db, kind)).toBe(0);
    }
    const fuel = readKidFuel(db, child.id, child.timezone, WHEN);
    expect(fuel.heat.state).toBe("dormant");
    expect(fuel.pieces).toEqual([]);
    expect(readCompanion(db, child.id, WHEN).badges).toEqual([]);
  });

  it("credits heat, XP, and the hot-streak piece once", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const input = tryInput(session.sessionId, WHEN, { idempotencyKey: "qe-once-day-1" });
    const first = submitAttempt(db, guardian.id, child.id, input, { now: WHEN });
    expect(first.celebrationTier).toBe("full");
    expect(first.fuel.credit).toBe(XP_AMOUNT.full);
    expect(first.fuel.heatEventId).toBeTruthy();
    expect(first.eventIds).toContain(first.fuel.heatEventId);
    expect(first.fuel.pieceEventIds).toEqual([]);
    expect(readKidFuel(db, child.id, child.timezone, WHEN).heat).toMatchObject({
      state: "warm",
      sourceEventId: first.fuel.heatEventId,
      lastQualifyingDay: "2026-06-15",
    });

    const replay = submitAttempt(db, guardian.id, child.id, { ...input, answer: "0" }, { now: NEXT });
    expect(replay.replayed).toBe(true);
    expect(replay.eventIds).toEqual(first.eventIds);
    expect(replay.fuel).toEqual(first.fuel);
    expect(accruedXp(db, child.id)).toBe(XP_AMOUNT.full);
    expect(countKind(db, "QualifyingPracticeDay")).toBe(1);

    const second = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, NEXT, { idempotencyKey: "qe-once-day-2" }),
      { now: NEXT },
    );
    expect(second.fuel.credit).toBe(XP_AMOUNT.full);
    expect(second.fuel.pieceEventIds).toHaveLength(1);
    expect(second.eventIds).toEqual(expect.arrayContaining(second.fuel.pieceEventIds));
    const hot = readKidFuel(db, child.id, child.timezone, NEXT);
    expect(hot.heat.state).toBe("hot");
    expect(hot.accrued).toBe(XP_AMOUNT.full * 2);
    expect(hot.pieces.map((piece) => piece.eventId)).toEqual(second.fuel.pieceEventIds);
    expect(hot.pieces[0]?.role).toBe("streak");

    const again = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, NEXT, { idempotencyKey: "qe-once-day-2" }),
      { now: NEXT },
    );
    expect(again.replayed).toBe(true);
    expect(again.fuel.pieceEventIds).toEqual(second.fuel.pieceEventIds);
    expect(readKidFuel(db, child.id, child.timezone, NEXT).accrued).toBe(XP_AMOUNT.full * 2);
    expect(countKind(db, "BuildPieceUnlock")).toBe(1);
    expect(countKind(db, "QualifyingPracticeDay")).toBe(2);

    const sameDay = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, NEXT, {
        answer: "0",
        idempotencyKey: "qe-same-day-volume",
      }),
      { now: NEXT },
    );
    expect(sameDay.fuel.credit).toBe(XP_AMOUNT.quietXp);
    expect(sameDay.fuel.heatEventId).toBeNull();
    expect(sameDay.fuel.pieceEventIds).toEqual([]);
    expect(readKidFuel(db, child.id, child.timezone, NEXT).heat.state).toBe("hot");
    expect(countKind(db, "BuildPieceUnlock")).toBe(1);
    expect(countKind(db, "QualifyingPracticeDay")).toBe(2);
    expect(accruedXp(db, child.id)).toBe(XP_AMOUNT.full * 2 + XP_AMOUNT.quietXp);
  });

  it("does not claw XP back and ignores a streak column with no qualifying day", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const credited = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, WHEN, { idempotencyKey: "accrue-only-1" }),
      { now: WHEN },
    );
    const held = accruedXp(db, child.id);
    expect(held).toBe(XP_AMOUNT.full);
    submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, WHEN, { answer: "   ", idempotencyKey: "accrue-blank" }),
      { now: WHEN },
    );
    expect(accruedXp(db, child.id)).toBe(held);
    expect(() => db.prepare(`UPDATE xp_events SET amount = amount - 1`).run()).toThrow(/append-only/);
    expect(accruedXp(db, child.id)).toBe(held);

    db.prepare(
      `UPDATE learner_progress
       SET streak_state = 'dormant', last_qualifying_day = NULL, ember_expires_at = NULL
       WHERE child_id = ?`,
    ).run(child.id);
    const healed = readCompanion(db, child.id, WHEN);
    expect(healed.streak.state).toBe("warm");
    expect(healed.streak.sourceEventId).toBe(credited.fuel.heatEventId);

    const other = createChild(db, guardian.id, { displayName: "Nico", timezone: "America/Los_Angeles" });
    setConsent(db, guardian.id, other.id, "grant");
    startPracticeSession(db, guardian.id, other.id);
    db.prepare(
      `UPDATE learner_progress
       SET streak_state = 'hot', last_qualifying_day = '2026-06-15', ember_expires_at = ?
       WHERE child_id = ?`,
    ).run("2026-06-17T07:00:00.000Z", other.id);
    const ignored = readCompanion(db, other.id, WHEN);
    expect(ignored.streak.state).toBe("dormant");
    expect(ignored.streak.sourceEventId).toBeNull();
    expect(readStreak(db, other.id).state).toBe("dormant");
  });

  it("keeps the parent one-breath card free of XP", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, WHEN, { idempotencyKey: "parent-no-xp" }),
      { now: WHEN },
    );
    const summary = readParentSummary(db, guardian.id, child.id, WHEN);
    expect(Object.keys(summary).sort()).toEqual([...PARENT_SUMMARY_KEYS].sort());
    expect(JSON.stringify(summary)).not.toMatch(/xp|credit|streak|badge|piece/i);
    const html = renderToStaticMarkup(createElement(ParentOneBreathCard, { summary }));
    expect(html).not.toMatch(/xp|sprout|streak|piece/i);
    const parentPage = readFileSync(new URL("../app/parent/page.tsx", import.meta.url), "utf8");
    expect(parentPage).not.toContain("FuelMoment");
    expect(parentPage).not.toContain("xpAmount");
  });
});

describe("fuel motion", () => {
  it("mints only from a qualifying event and wanes without one", () => {
    expect(xpBacked({ credit: 0, eventCount: 0, tier: "full" })).toBe(false);
    expect(xpBacked({ credit: XP_AMOUNT.full, eventCount: 1, tier: "full" })).toBe(true);
    expect(
      fuelMotion({
        previousHeat: "dormant",
        nextHeat: "warm",
        previousPieceIds: [],
        nextPieceIds: [],
        credit: XP_AMOUNT.full,
        heatEventId: "day-1",
        replayed: false,
      }),
    ).toEqual({ heat: "mint", pieces: "steady", xp: "mint" });
    expect(
      fuelMotion({
        previousHeat: "warm",
        nextHeat: "hot",
        previousPieceIds: [],
        nextPieceIds: ["piece-1"],
        credit: 0,
        heatEventId: null,
        replayed: false,
      }).heat,
    ).toBe("steady");
    expect(
      fuelMotion({
        previousHeat: "warm",
        nextHeat: "ember",
        previousPieceIds: ["piece-1"],
        nextPieceIds: ["piece-1"],
        credit: 0,
        heatEventId: null,
        replayed: false,
      }),
    ).toEqual({ heat: "wane", pieces: "steady", xp: "steady" });
    expect(
      fuelMotion({
        previousHeat: "dormant",
        nextHeat: "warm",
        previousPieceIds: null,
        nextPieceIds: ["piece-1"],
        credit: XP_AMOUNT.full,
        heatEventId: "day-1",
        replayed: true,
      }),
    ).toEqual({ heat: "steady", pieces: "steady", xp: "steady" });

    const empty = projectHeat([], "America/Los_Angeles", WHEN);
    expect(empty.state).toBe("dormant");
    const warmed = projectHeat(
      [{ id: "qe-day", localDay: "2026-06-15" }],
      "America/Los_Angeles",
      WHEN,
    );
    expect(warmed).toMatchObject({ state: "warm", sourceEventId: "qe-day", lastQualifyingDay: "2026-06-15" });
  });

  it("renders heat, a backed sprout, and a piece from qualifying-event props", () => {
    const html = renderToStaticMarkup(
      createElement(FuelMoment, {
        heat: {
          streakState: "ember",
          copyKey: "streak.ember",
          sourceEventId: "qe-day",
          motion: "wane",
        },
        pieceEventIds: ["piece-1"],
        pieceMotion: "mint",
        xp: { credit: 0, eventCount: 0, tier: "full", replayed: false },
      }),
    );
    expect(html).toContain('data-fuel-source="qualifying-event"');
    expect(html).toContain('data-testid="fuel-heat"');
    expect(html).toContain('data-waning="true"');
    expect(html).toContain('data-heat-motion="wane"');
    expect(html).toContain('data-heat-event-id="qe-day"');
    expect(html).toContain('data-xp-backed="false"');
    expect(html).toContain("No sprout this time.");
    expect(html).not.toContain("A sprout for that try.");
    expect(html).toContain('data-testid="fuel-piece"');
    expect(html).toContain("A piece of the build is in place.");
    expect(html).not.toMatch(/xpAmount|score|confidence/i);

    const sproutOnly = renderToStaticMarkup(
      createElement(FuelMoment, {
        heat: null,
        pieceEventIds: [],
        pieceMotion: "steady",
        xp: { credit: XP_AMOUNT.full, eventCount: 1, tier: "full", replayed: false },
      }),
    );
    expect(sproutOnly).toContain("A sprout for that try.");
    expect(sproutOnly).toContain('data-xp-backed="true"');
    expect(sproutOnly).not.toContain('data-testid="fuel-heat"');

    const home = renderToStaticMarkup(
      createElement(CompanionState, {
        childId: "child-1",
        practiceAllowed: true,
        companion: {
          build: {
            active: {
              id: "pot",
              title: "A pot for the sprout",
              pieceTarget: 3,
              pieces: [],
              complete: false,
              active: true,
            },
            completed: [],
          },
          badges: [],
          streak: {
            state: "dormant",
            copyKey: "streak.dormant",
            emberExpiresAt: null,
            lastQualifyingDay: null,
            sourceEventId: null,
            recovery: null,
          },
        },
      }),
    );
    expect(home).toContain('data-fuel-source="qualifying-event"');
    expect(home).toContain('data-fuel="heat"');
    expect(home).toContain('data-fuel="pieces"');
    expect(home).not.toMatch(/xpAmount|confidence|score/i);
  });
});

describe("anti-farm spine", () => {
  it("still stamps policy_version, seals ClientView, and holds pause apart from revoke", () => {
    expect(new MasteryEstimator().policyVersion).toBe(POLICY_VERSION);
    expect(new MasteryEstimator().policyVersion).toBe("rules-v0");
    expect(() =>
      assertCelebrationBacked({
        tier: "full",
        xpCount: 0,
        integrityLane: "celebrate",
        practiceLane: "recommended",
      }),
    ).toThrow(/requires a mint/);
    expect(queueDisposition("paused")).toBe("hold");
    expect(queueDisposition("revoked")).toBe("drop");

    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const input = tryInput(session.sessionId, WHEN, { idempotencyKey: "spine-replay-1" });
    const first = submitAttempt(db, guardian.id, child.id, input, { now: WHEN });
    const replay = submitAttempt(db, guardian.id, child.id, input, { now: WHEN });
    expect(replay.replayed).toBe(true);
    expect(replay.eventIds).toEqual(first.eventIds);
    expect(replay.fuel).toEqual(first.fuel);
    expect(replay.clientView).not.toHaveProperty("confidence");
    expect(JSON.stringify(replay.clientView)).not.toMatch(/score|confidence|judgment|judgement/i);
    const attempt = db
      .prepare(`SELECT policy_version FROM attempts WHERE id = ?`)
      .get(first.attemptId) as { policy_version: string };
    expect(attempt.policy_version).toBe(new MasteryEstimator().policyVersion);
  });
});
