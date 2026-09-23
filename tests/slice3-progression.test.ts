import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type DatabaseT from "better-sqlite3";
import { XP_AMOUNT } from "@/lib/attempt-contract";
import {
  startPracticeSession,
  submitAttempt,
  type SubmitAttemptInput,
} from "@/lib/attempts";
import {
  choosePracticeLane,
  endPracticeSession,
  getBoundaryOptions,
  parseLaneChoice,
} from "@/lib/boundary";
import { openDatabase } from "@/lib/db";
import { DomainError, createChild, createGuardian, setConsent } from "@/lib/domain";
import { canonicalAnswer } from "@/lib/item-bank";
import {
  evidenceForSkill,
  readDifficulty,
  readPracticeSession,
  readSkillClientView,
} from "@/lib/learner-state";
import {
  MasteryEstimator,
  isQualifyingEvidence,
  practiceLaneOrRecommended,
  type MasteryEstimator as MasteryEstimatorContract,
  type SkillEvidence,
} from "@/lib/mastery";

const cleanups: Array<() => void> = [];
const T0 = Date.parse("2026-04-01T00:00:00.000Z");

function tempDb(): DatabaseT.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-slice3-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function grantedChild(db: DatabaseT.Database) {
  const guardian = createGuardian(db, {
    email: "parent@example.com",
    password: "correct-horse",
    timezone: "America/Los_Angeles",
  });
  const child = createChild(db, guardian.id, { displayName: "Ava" });
  setConsent(db, guardian.id, child.id, "grant");
  const session = startPracticeSession(db, guardian.id, child.id);
  return { guardian, child, session };
}

function tryInput(
  sessionId: string,
  index: number,
  overrides: Partial<SubmitAttemptInput> = {},
): SubmitAttemptInput {
  const submitted = index * 20_000;
  return {
    idempotencyKey: `slice3-key-${index}-${randomUUID().slice(0, 8)}`,
    sessionId,
    itemId: "ops-g2-add",
    answer: "42",
    shownAt: at(submitted),
    submittedAt: at(submitted + 2_000),
    ...overrides,
  };
}

function skillRow(db: DatabaseT.Database, childId: string) {
  return db
    .prepare(
      `SELECT band_label, show_concept_chip, celebration_tier
       FROM learner_skill_state WHERE child_id = ?`,
    )
    .all(childId) as Array<{
    band_label: string;
    show_concept_chip: number;
    celebration_tier: string;
  }>;
}

function levelUpCount(db: DatabaseT.Database) {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM boundary_events`).get() as { count: number }
  ).count;
}

const recommended = (correct: boolean): SkillEvidence => ({
  correct,
  lane: "celebrate",
  practiceLane: "recommended",
});

const reviewTry = (correct: boolean): SkillEvidence => ({
  correct,
  lane: "celebrate",
  practiceLane: "review",
});

describe("mastery rules", () => {
  const estimator: MasteryEstimatorContract = new MasteryEstimator();

  it("keeps one clean try at Getting it", () => {
    expect(
      estimator.toClientView({
        correct: true,
        lane: "celebrate",
        celebrationTier: "full",
      }),
    ).toEqual({
      bandLabel: "Getting it",
      showConceptChip: true,
      celebrationTier: "full",
    });
    expect(estimator.decideProgression([recommended(true)])).toBe("stay");
  });

  it("reaches Got it and LevelUpSlight from Recommended or Challenge evidence", () => {
    const recommendedWindow = [recommended(true), recommended(true), recommended(true)];
    expect(
      estimator.toClientView({
        correct: true,
        lane: "celebrate",
        celebrationTier: "full",
        practiceLane: "recommended",
        history: recommendedWindow.slice(0, 2),
      }).bandLabel,
    ).toBe("Got it");
    expect(estimator.decideProgression(recommendedWindow)).toBe("levelUpSlight");

    const challengeWindow: SkillEvidence[] = [1, 2, 3].map(() => ({
      correct: true,
      lane: "celebrate",
      practiceLane: "challenge",
    }));
    expect(estimator.decideProgression(challengeWindow)).toBe("levelUpSlight");
    expect(challengeWindow.every(isQualifyingEvidence)).toBe(true);
  });

  it("does not let Review evidence fake Got it or LevelUpSlight", () => {
    const onlyReview = [reviewTry(true), reviewTry(true), reviewTry(true)];
    const view = estimator.toClientView({
      correct: true,
      lane: "celebrate",
      celebrationTier: "full",
      practiceLane: "review",
      history: onlyReview.slice(0, 2),
    });
    expect(view.bandLabel).toBe("Getting it");
    expect(view.bandLabel).not.toBe("Got it");
    expect(estimator.decideProgression(onlyReview)).toBe("stay");
    expect(onlyReview.some(isQualifyingEvidence)).toBe(false);

    const twoRecommendedThenReview = [
      recommended(true),
      recommended(true),
      reviewTry(true),
    ];
    expect(estimator.decideProgression(twoRecommendedThenReview)).not.toBe("levelUpSlight");
    expect(
      estimator.toClientView({
        correct: true,
        lane: "celebrate",
        celebrationTier: "full",
        practiceLane: "review",
        history: [recommended(true), recommended(true)],
      }).bandLabel,
    ).toBe("Getting it");
  });

  it("still honors Recommended evidence that was already in the window", () => {
    const earned = [recommended(true), recommended(true), recommended(true), reviewTry(true)];
    expect(estimator.decideProgression(earned)).toBe("levelUpSlight");
    expect(
      estimator.toClientView({
        correct: true,
        lane: "celebrate",
        celebrationTier: "full",
        practiceLane: "review",
        history: earned.slice(0, 3),
      }).bandLabel,
    ).toBe("Got it");
  });

  it("asks for a smaller step after two careful misses", () => {
    expect(estimator.decideProgression([recommended(false)])).toBe("stay");
    expect(estimator.decideProgression([recommended(false), recommended(false)])).toBe(
      "remediate",
    );
    expect(
      estimator.toClientView({
        correct: false,
        lane: "celebrate",
        celebrationTier: "quietXp",
        history: [recommended(false)],
      }),
    ).toEqual({
      bandLabel: "Still learning",
      showConceptChip: true,
      celebrationTier: "quietXp",
    });
  });

  it("treats an unknown lane as Recommended", () => {
    expect(practiceLaneOrRecommended("sideways")).toBe("recommended");
    expect(practiceLaneOrRecommended(null)).toBe("recommended");
    expect(practiceLaneOrRecommended("")).toBe("recommended");
    expect(parseLaneChoice("nope")).toBe("recommended");
    expect(parseLaneChoice("challenge")).toBe("challenge");
    expect(parseLaneChoice("review")).toBe("review");

    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE practice_sessions (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL,
        status TEXT NOT NULL,
        item_index INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        practice_lane TEXT NOT NULL,
        phase TEXT NOT NULL,
        progression TEXT
      );
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        correct INTEGER NOT NULL,
        lane TEXT NOT NULL,
        item_id TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO practice_sessions (
        id, child_id, status, item_index, started_at, practice_lane, phase, progression
      ) VALUES (
        'sess-unknown', 'child-1', 'active', 0, '2026-04-01T00:00:00.000Z',
        'sideways', 'practicing', NULL
      );
      INSERT INTO attempts (
        id, child_id, session_id, correct, lane, item_id, submitted_at, created_at
      ) VALUES (
        'attempt-1', 'child-1', 'sess-unknown', 1, 'celebrate', 'ops-g2-add',
        '2026-04-01T00:00:02.000Z', '2026-04-01T00:00:02.000Z'
      );
    `);

    expect(readPracticeSession(db, "child-1", "sess-unknown")?.practice_lane).toBe(
      "recommended",
    );
    const evidence = evidenceForSkill(db, "child-1", "adding two-digit numbers");
    expect(evidence).toEqual([
      { correct: true, lane: "celebrate", practiceLane: "recommended" },
    ]);
    expect(isQualifyingEvidence(evidence[0] as SkillEvidence)).toBe(true);
    db.close();
  });

  it("drops Got it when the latest careful try misses", () => {
    const window = [recommended(true), recommended(true), recommended(true), recommended(false)];
    expect(estimator.decideProgression(window)).toBe("stay");
    expect(
      estimator.toClientView({
        correct: false,
        lane: "celebrate",
        celebrationTier: "quietXp",
        history: window.slice(0, 3),
      }).bandLabel,
    ).toBe("Getting it");
  });
});

describe("attempt path uses the estimator", () => {
  it("moves the chip to Got it on the third Recommended success and keeps the mint", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const bands: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = submitAttempt(
        db,
        guardian.id,
        child.id,
        tryInput(session.sessionId, index),
      );
      bands.push(result.clientView.bandLabel);
      expect(result.celebrationTier).toBe("full");
      expect(result.clientView.celebrationTier).toBe("full");
      expect(result.xpAmount).toBe(XP_AMOUNT.full);
      expect(JSON.stringify(result)).not.toMatch(/score|confidence|percent/i);
    }
    expect(bands).toEqual(["Getting it", "Getting it", "Got it"]);
    expect(skillRow(db, child.id)).toEqual([
      {
        band_label: "Got it",
        show_concept_chip: 1,
        celebration_tier: "full",
      },
    ]);
  });

  it("rolls learner state back with the attempt when the mint fails", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    db.exec(`
      CREATE TRIGGER fail_mint BEFORE INSERT ON xp_events
      BEGIN
        SELECT RAISE(ABORT, 'mint failed');
      END;
    `);
    expect(() =>
      submitAttempt(db, guardian.id, child.id, tryInput(session.sessionId, 0)),
    ).toThrow(/mint failed/);
    expect(skillRow(db, child.id)).toEqual([]);
  });
});

describe("session boundary", () => {
  it("offers lanes only after the session ends, with Recommended as the default", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    expect(session.lane).toBe("recommended");
    expect(session.atBoundary).toBe(false);
    expect(session.clientView).toBeNull();

    expect(() =>
      getBoundaryOptions(db, guardian.id, child.id, session.sessionId),
    ).toThrow(DomainError);
    expect(() =>
      choosePracticeLane(db, guardian.id, child.id, session.sessionId, "challenge"),
    ).toThrow(DomainError);

    submitAttempt(db, guardian.id, child.id, tryInput(session.sessionId, 0, { answer: "41" }));
    submitAttempt(db, guardian.id, child.id, tryInput(session.sessionId, 1, { answer: "41" }));
    const options = endPracticeSession(db, guardian.id, child.id, session.sessionId);

    expect(options.boundary).toBe("session");
    expect(options.defaultLane).toBe("recommended");
    expect(options.progression).toBe("remediate");
    expect(options.levelUpSlight).toBe(false);
    expect(options.options.map((option) => option.lane)).toEqual([
      "recommended",
      "challenge",
      "review",
    ]);
    expect(options.options.find((option) => option.lane === "recommended")).toMatchObject({
      isDefault: true,
      available: true,
    });
    expect(options.options.find((option) => option.lane === "review")?.remaining).toBeGreaterThan(
      0,
    );
    expect(JSON.stringify(options)).not.toMatch(/score|confidence|percent/i);
    expect(levelUpCount(db)).toBe(0);

    expect(() =>
      submitAttempt(db, guardian.id, child.id, tryInput(session.sessionId, 2)),
    ).toThrow(DomainError);

    const again = endPracticeSession(db, guardian.id, child.id, session.sessionId);
    expect(again.progression).toBe("remediate");
    expect(readDifficulty(db, child.id)).toBe(0);
  });

  it("fires one slightly-harder event when Recommended evidence says so", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    for (let index = 0; index < 3; index += 1) {
      submitAttempt(db, guardian.id, child.id, tryInput(session.sessionId, index));
    }
    const options = endPracticeSession(db, guardian.id, child.id, session.sessionId);
    endPracticeSession(db, guardian.id, child.id, session.sessionId);

    expect(options.progression).toBe("levelUpSlight");
    expect(options.levelUpSlight).toBe(true);
    expect(options.clientView.bandLabel).toBe("Got it");
    expect(options.options.map((option) => option.lane)).toEqual(["recommended", "challenge"]);
    expect(levelUpCount(db)).toBe(1);
    expect(readDifficulty(db, child.id)).toBe(1);
    expect(() =>
      choosePracticeLane(db, guardian.id, child.id, session.sessionId, "review"),
    ).toThrow(/still left/);

    choosePracticeLane(db, guardian.id, child.id, session.sessionId, "recommended");
    const next = startPracticeSession(db, guardian.id, child.id);
    expect(next.sessionId).not.toBe(session.sessionId);
    expect(next.lane).toBe("recommended");
    expect(next.item.id).toBe("ops-g3-mul");
    expect(next.item.grade).toBe(3);
    expect(levelUpCount(db)).toBe(1);
  });

  it("keeps a Getting it chip on the next session", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    for (let index = 0; index < 2; index += 1) {
      submitAttempt(db, guardian.id, child.id, tryInput(session.sessionId, index));
    }
    const ended = endPracticeSession(db, guardian.id, child.id, session.sessionId);
    expect(ended.progression).toBe("stay");
    expect(ended.clientView).toEqual({
      bandLabel: "Getting it",
      showConceptChip: true,
      celebrationTier: "full",
    });

    choosePracticeLane(db, guardian.id, child.id, session.sessionId, "recommended");
    const next = startPracticeSession(db, guardian.id, child.id);
    expect(next.clientView).toEqual(ended.clientView);
    expect(next.item.skill).toBe("adding two-digit numbers");
    expect(readSkillClientView(db, child.id, next.item.skill)?.bandLabel).toBe("Getting it");

    const third = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(next.sessionId, 2),
    );
    expect(third.clientView.bandLabel).toBe("Got it");
    expect(third.clientView.showConceptChip).toBe(true);
  });

  it("does not let a Review session produce Got it or LevelUpSlight", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(session.sessionId, 0, { answer: "41" }),
    );
    endPracticeSession(db, guardian.id, child.id, session.sessionId);
    choosePracticeLane(db, guardian.id, child.id, session.sessionId, "review");
    const review = startPracticeSession(db, guardian.id, child.id);
    expect(review.lane).toBe("review");

    const bands: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const result = submitAttempt(
        db,
        guardian.id,
        child.id,
        tryInput(review.sessionId, index),
      );
      bands.push(result.clientView.bandLabel);
      expect(result.celebrationTier).toBe("full");
      expect(result.xpAmount).toBe(XP_AMOUNT.full);
    }
    expect(bands.every((band) => band !== "Got it")).toBe(true);
    expect(bands[2]).toBe("Getting it");

    const options = endPracticeSession(db, guardian.id, child.id, review.sessionId);
    expect(options.progression).not.toBe("levelUpSlight");
    expect(options.levelUpSlight).toBe(false);
    expect(options.clientView.bandLabel).not.toBe("Got it");
    expect(levelUpCount(db)).toBe(0);
    expect(readDifficulty(db, child.id)).toBe(0);
  });

  it("treats Challenge evidence as enough for a slightly harder step", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    submitAttempt(db, guardian.id, child.id, tryInput(session.sessionId, 0));
    endPracticeSession(db, guardian.id, child.id, session.sessionId);
    choosePracticeLane(db, guardian.id, child.id, session.sessionId, "challenge");
    const challenge = startPracticeSession(db, guardian.id, child.id);
    expect(challenge.lane).toBe("challenge");
    expect(challenge.item.grade).toBeGreaterThanOrEqual(3);

    let latestBand = "";
    for (let index = 1; index <= 3; index += 1) {
      const result = submitAttempt(
        db,
        guardian.id,
        child.id,
        tryInput(challenge.sessionId, index, {
          itemId: challenge.item.id,
          answer: canonicalAnswer(challenge.item.id),
        }),
      );
      latestBand = result.clientView.bandLabel;
    }
    expect(latestBand).toBe("Got it");
    const options = endPracticeSession(db, guardian.id, child.id, challenge.sessionId);
    expect(options.progression).toBe("levelUpSlight");
    expect(levelUpCount(db)).toBe(1);
  });

  it("refuses to end a session or change lanes without consent", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    submitAttempt(db, guardian.id, child.id, tryInput(session.sessionId, 0));
    setConsent(db, guardian.id, child.id, "pause");
    expect(() => endPracticeSession(db, guardian.id, child.id, session.sessionId)).toThrow(
      DomainError,
    );
    expect(levelUpCount(db)).toBe(0);
  });
});

describe("slice 2 database upgrade", () => {
  it("adds lane and learner tables without dropping the old session", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-upgrade-"));
    const filename = path.join(dir, "old.sqlite");
    const raw = new Database(filename);
    raw.exec(`
      CREATE TABLE practice_sessions (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active')),
        item_index INTEGER NOT NULL CHECK (item_index >= 0),
        started_at TEXT NOT NULL
      );
      INSERT INTO practice_sessions (id, child_id, status, item_index, started_at)
      VALUES ('sess-old', 'child-old', 'active', 2, '2026-01-01T00:00:00.000Z');
    `);
    raw.close();

    const db = openDatabase(filename);
    cleanups.push(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const row = db
      .prepare(
        `SELECT item_index, practice_lane, phase, progression FROM practice_sessions WHERE id = ?`,
      )
      .get("sess-old") as {
      item_index: number;
      practice_lane: string;
      phase: string;
      progression: string | null;
    };
    expect(row).toEqual({
      item_index: 2,
      practice_lane: "recommended",
      phase: "practicing",
      progression: null,
    });
    const names = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
             'learner_skill_state', 'learner_progress', 'boundary_events'
           )`,
        )
        .all() as Array<{ name: string }>
    ).map((table) => table.name);
    expect(names.sort()).toEqual(
      ["boundary_events", "learner_progress", "learner_skill_state"].sort(),
    );
  });
});
