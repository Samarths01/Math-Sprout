import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  FOUR_BEAT_KEYS,
  foldRewards,
  resolveCelebration,
  SPAM_MAX_IN_WINDOW,
  TOO_FAST_MS,
  XP_AMOUNT,
  type AttemptResult,
} from "@/lib/attempt-contract";
import {
  startPracticeSession,
  submitAttempt,
  type SubmitAttemptInput,
} from "@/lib/attempts";
import { openDatabase } from "@/lib/db";
import { DomainError, createChild, createGuardian, setConsent } from "@/lib/domain";
import { ITEM_CATALOG } from "@/lib/item-catalog";
import { assertBankMatchesCatalog, gradeAnswer } from "@/lib/item-bank";
import { readAttemptLog } from "@/lib/attempt-log";
import { MasteryEstimator } from "@/lib/mastery";
import { POLICY_VERSION } from "@/lib/policy";
import {
  createAttemptQueue,
  memoryQueueStore,
  storageQueueStore,
  type QueuedAttempt,
  type SyncPost,
} from "@/lib/offline-queue";

const cleanups: Array<() => void> = [];
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function tempDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-slice2-"));
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

function count(db: Database.Database, table: "attempts" | "xp_events" | "practice_sessions") {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  ).count;
}

function grantedChild(db: Database.Database) {
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

function input(
  sessionId: string,
  overrides: Partial<SubmitAttemptInput> = {},
): SubmitAttemptInput {
  return {
    idempotencyKey: randomUUID(),
    sessionId,
    itemId: "ops-g2-add",
    answer: "42",
    shownAt: at(0),
    submittedAt: at(2_000),
    ...overrides,
  };
}

function expectClientViewSealed(result: AttemptResult) {
  expect(Object.keys(result.clientView).sort()).toEqual([
    "bandLabel",
    "celebrationTier",
    "showConceptChip",
  ]);
  expect(["Still learning", "Getting it", "Got it"]).toContain(result.clientView.bandLabel);
  expect(["none", "quietXp", "full"]).toContain(result.clientView.celebrationTier);
  expect(typeof result.clientView.showConceptChip).toBe("boolean");
  const view = JSON.stringify(result.clientView);
  expect(view).not.toMatch(/score|confidence|percent/i);
  expect(result.clientView).not.toHaveProperty("score");
  expect(result.clientView).not.toHaveProperty("confidence");
  expect(result.clientView).not.toHaveProperty("scorePercent");
  expect(result).not.toHaveProperty("score");
  expect(result).not.toHaveProperty("confidence");
  expect(result).not.toHaveProperty("policyVersion");
  expect(JSON.stringify(result)).not.toMatch(
    /scorePercent|confidence|rawConfidence|percentCorrect/i,
  );
}

function xpRows(db: Database.Database) {
  return db
    .prepare(
      `SELECT id, attempt_id, amount, celebration_tier FROM xp_events ORDER BY minted_at ASC, id ASC`,
    )
    .all() as Array<{
    id: string;
    attempt_id: string;
    amount: number;
    celebration_tier: string;
  }>;
}

describe("idempotent attempt replay", () => {
  it("returns the original attempt and minted event ids", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const firstInput = input(session.sessionId, { idempotencyKey: "attempt-key-001" });
    const first = submitAttempt(db, guardian.id, child.id, firstInput);
    const replay = submitAttempt(db, guardian.id, child.id, {
      ...firstInput,
      answer: "0",
      submittedAt: at(9_000),
    });

    expect(replay.replayed).toBe(true);
    expect(replay.attemptId).toBe(first.attemptId);
    expect(replay.eventIds).toEqual(first.eventIds);
    expect(replay.eventIds).toHaveLength(1);
    expect(replay.correct).toBe(true);
    expect(replay.celebrationTier).toBe(first.celebrationTier);
    expect(replay.xpAmount).toBe(first.xpAmount);
    expect(replay.whatWentWell).toBe(first.whatWentWell);
    expectClientViewSealed(replay);
    expect(replay.clientView).toEqual(first.clientView);
    expect(count(db, "attempts")).toBe(1);
    expect(count(db, "xp_events")).toBe(1);
    expect(xpRows(db)[0]?.id).toBe(first.eventIds[0]);
  });

  it("does not answer a duplicate key with an empty 409", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const firstInput = input(session.sessionId, { idempotencyKey: "attempt-key-002" });
    const first = submitAttempt(db, guardian.id, child.id, firstInput);
    const replay = submitAttempt(db, guardian.id, child.id, firstInput);

    expect(replay).toMatchObject({
      attemptId: first.attemptId,
      eventIds: first.eventIds,
      xpAmount: XP_AMOUNT.full,
      replayed: true,
    });
    expect(replay.eventIds.length).toBeGreaterThan(0);
    expectClientViewSealed(replay);
    expect(count(db, "xp_events")).toBe(1);
  });

  it("still replays the original mint after consent is revoked", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const firstInput = input(session.sessionId, { idempotencyKey: "attempt-key-003" });
    const first = submitAttempt(db, guardian.id, child.id, firstInput);
    setConsent(db, guardian.id, child.id, "revoke");

    const replay = submitAttempt(db, guardian.id, child.id, firstInput);
    expect(replay.replayed).toBe(true);
    expect(replay.eventIds).toEqual(first.eventIds);
    expect(() =>
      submitAttempt(
        db,
        guardian.id,
        child.id,
        input(session.sessionId, { idempotencyKey: "attempt-key-004" }),
      ),
    ).toThrow(DomainError);
    expect(count(db, "attempts")).toBe(1);
    expect(count(db, "xp_events")).toBe(1);
  });
});

describe("integrity gates", () => {
  it("keeps an empty answer in the review lane with no mint", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const result = submitAttempt(
      db,
      guardian.id,
      child.id,
      input(session.sessionId, { answer: "   " }),
    );

    expect(result.correct).toBe(false);
    expect(result.flags).toContain("empty_answer");
    expect(result.lane).toBe("review");
    expect(result.celebrationTier).toBe("none");
    expect(result.clientView).toEqual({
      bandLabel: "Still learning",
      showConceptChip: false,
      celebrationTier: "none",
    });
    expect(result.eventIds).toEqual([]);
    expect(result.xpAmount).toBe(0);
    expectClientViewSealed(result);
    expect(count(db, "xp_events")).toBe(0);
  });

  it("keeps a too-fast answer in the review lane with no full mint", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const result = submitAttempt(
      db,
      guardian.id,
      child.id,
      input(session.sessionId, {
        answer: "42",
        shownAt: at(0),
        submittedAt: at(TOO_FAST_MS - 1),
      }),
    );

    expect(result.flags).toContain("too_fast");
    expect(result.lane).toBe("review");
    expect(result.celebrationTier).toBe("none");
    expect(result.eventIds).toEqual([]);
    expectClientViewSealed(result);
    expect(count(db, "xp_events")).toBe(0);
  });

  it("puts only the spam window into quietXp", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const results: AttemptResult[] = [];
    for (let index = 0; index <= SPAM_MAX_IN_WINDOW; index += 1) {
      const submitted = index * 1_000;
      results.push(
        submitAttempt(
          db,
          guardian.id,
          child.id,
          input(session.sessionId, {
            idempotencyKey: `spam-key-${index}`,
            shownAt: at(submitted - 2_000),
            submittedAt: at(submitted),
            answer: "42",
          }),
        ),
      );
    }

    const paced = results.slice(0, SPAM_MAX_IN_WINDOW);
    const spam = results[SPAM_MAX_IN_WINDOW];
    expect(paced.every((result) => result.celebrationTier === "full")).toBe(true);
    expect(spam?.flags).toContain("spam_window");
    expect(spam?.lane).toBe("review");
    expect(spam?.celebrationTier).toBe("quietXp");
    expect(spam?.xpAmount).toBe(XP_AMOUNT.quietXp);
    expect(["quietXp", "none"]).toContain(spam?.celebrationTier);
    expect(spam?.celebrationTier).not.toBe("full");
    expectClientViewSealed(spam as AttemptResult);
  });

  it("limits every review lane to quietXp or none", () => {
    const cases = [
      { correct: true, flags: ["empty_answer"] as const },
      { correct: true, flags: ["too_fast"] as const },
      { correct: false, flags: ["spam_window"] as const },
      { correct: true, flags: ["empty_answer", "spam_window"] as const },
      { correct: true, flags: ["too_fast", "spam_window"] as const },
    ];
    for (const item of cases) {
      const resolved = resolveCelebration(item);
      expect(resolved.lane).toBe("review");
      expect(["quietXp", "none"]).toContain(resolved.celebrationTier);
    }
    expect(resolveCelebration({ correct: true, flags: [] })).toMatchObject({
      lane: "celebrate",
      celebrationTier: "full",
      xpAmount: XP_AMOUNT.full,
    });
  });
});

describe("celebration mint", () => {
  it("writes the tier and the xp event in one transaction", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const result = submitAttempt(db, guardian.id, child.id, input(session.sessionId));
    const row = db
      .prepare(
        `SELECT a.celebration_tier AS attempt_tier, e.celebration_tier AS event_tier, e.amount, e.id
         FROM attempts a JOIN xp_events e ON e.attempt_id = a.id
         WHERE a.id = ?`,
      )
      .get(result.attemptId) as {
      attempt_tier: string;
      event_tier: string;
      amount: number;
      id: string;
    };

    expect(row.attempt_tier).toBe("full");
    expect(row.event_tier).toBe("full");
    expect(row.amount).toBe(XP_AMOUNT.full);
    expect(result.eventIds).toEqual([row.id]);
  });

  it("rolls the attempt back when the mint fails", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    db.exec(`
      CREATE TRIGGER fail_mint BEFORE INSERT ON xp_events
      BEGIN
        SELECT RAISE(ABORT, 'mint failed');
      END;
    `);

    expect(() =>
      submitAttempt(db, guardian.id, child.id, input(session.sessionId)),
    ).toThrow(/mint failed/);
    expect(count(db, "attempts")).toBe(0);
    expect(count(db, "xp_events")).toBe(0);
  });

  it("mints quietXp for a careful miss and nothing for a blank", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const missed = submitAttempt(
      db,
      guardian.id,
      child.id,
      input(session.sessionId, {
        idempotencyKey: "miss-key-0001",
        answer: "41",
        shownAt: at(0),
        submittedAt: at(3_000),
      }),
    );
    const blank = submitAttempt(
      db,
      guardian.id,
      child.id,
      input(session.sessionId, {
        idempotencyKey: "blank-key-0001",
        answer: "",
        shownAt: at(20_000),
        submittedAt: at(23_000),
      }),
    );

    expect(missed.lane).toBe("celebrate");
    expect(missed.celebrationTier).toBe("quietXp");
    expect(missed.clientView).toEqual({
      bandLabel: "Still learning",
      showConceptChip: true,
      celebrationTier: "quietXp",
    });
    expect(missed.xpAmount).toBe(1);
    expect(blank.celebrationTier).toBe("none");
    expect(xpRows(db).map((row) => row.amount)).toEqual([1]);
  });
});

describe("offline queue reconcile", () => {
  it("keeps attempts queued offline and reconciles them once", async () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const queue = createAttemptQueue(memoryQueueStore());
    const first: QueuedAttempt = {
      idempotencyKey: "offline-key-0001",
      childId: child.id,
      sessionId: session.sessionId,
      itemId: "ops-g2-add",
      answer: "42",
      shownAt: at(0),
      submittedAt: at(2_000),
    };
    const second: QueuedAttempt = {
      ...first,
      idempotencyKey: "offline-key-0002",
      itemId: "ops-g3-mul",
      answer: "56",
      shownAt: at(30_000),
      submittedAt: at(33_000),
    };
    queue.enqueue(first);
    queue.enqueue(second);

    let online = false;
    const post = async (attempt: QueuedAttempt): Promise<SyncPost> => {
      if (!online) return { ok: false, reason: "offline" };
      return {
        ok: true,
        result: submitAttempt(db, guardian.id, child.id, attempt),
      };
    };

    const waiting = await queue.reconcile(post);
    expect(waiting.pending).toHaveLength(2);
    expect(waiting.synced).toHaveLength(0);
    expect(count(db, "xp_events")).toBe(0);

    online = true;
    const synced = await queue.reconcile(post);
    expect(synced.pending).toHaveLength(0);
    expect(synced.synced.map((result) => result.idempotencyKey)).toEqual([
      first.idempotencyKey,
      second.idempotencyKey,
    ]);
    expect(synced.synced.every((result) => result.replayed)).toBe(false);
    const eventIds = synced.synced.flatMap((result) => result.eventIds);
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(count(db, "xp_events")).toBe(2);

    const again = await queue.reconcile(post);
    expect(again.synced).toHaveLength(2);
    expect(count(db, "xp_events")).toBe(2);

    const replay = submitAttempt(db, guardian.id, child.id, {
      ...first,
      answer: "nope",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.eventIds).toEqual(synced.synced[0]?.eventIds);
    expect(foldRewards([synced.synced[0] as AttemptResult, replay])).toEqual({
      eventIds: replay.eventIds,
      totalXp: replay.xpAmount,
    });
    expect(queue.rewards().totalXp).toBe(
      (synced.synced[0]?.xpAmount ?? 0) + (synced.synced[1]?.xpAmount ?? 0),
    );
    expect(count(db, "xp_events")).toBe(2);
  });

  it("stops on a dropped connection and continues later", async () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const queue = createAttemptQueue(memoryQueueStore());
    const attempt = {
      idempotencyKey: "flaky-key-0001",
      childId: child.id,
      sessionId: session.sessionId,
      itemId: "ops-g2-add",
      answer: "42",
      shownAt: at(0),
      submittedAt: at(2_000),
    };
    queue.enqueue(attempt);
    let calls = 0;
    const dropped = await queue.reconcile(async () => {
      calls += 1;
      throw new Error("socket hang up");
    });
    expect(dropped.pending).toHaveLength(1);
    expect(dropped.lastError).toMatch(/reach/i);
    expect(count(db, "attempts")).toBe(0);

    const synced = await queue.reconcile(async () => ({
      ok: true as const,
      result: submitAttempt(db, guardian.id, child.id, attempt),
    }));
    expect(calls).toBe(1);
    expect(synced.pending).toHaveLength(0);
    expect(synced.synced[0]?.eventIds).toHaveLength(1);
    expect(count(db, "xp_events")).toBe(1);
  });

  it("does not mint when a queued attempt syncs after consent is revoked", async () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const queue = createAttemptQueue(memoryQueueStore());
    const attempt = {
      idempotencyKey: "revoked-key-001",
      childId: child.id,
      sessionId: session.sessionId,
      itemId: "ops-g2-add",
      answer: "42",
      shownAt: at(0),
      submittedAt: at(2_000),
    };
    queue.enqueue(attempt);
    setConsent(db, guardian.id, child.id, "pause");

    const snapshot = await queue.reconcile(async (queued) => {
      try {
        return {
          ok: true as const,
          result: submitAttempt(db, guardian.id, child.id, queued),
        };
      } catch (error) {
        if (error instanceof DomainError && error.status === 403) {
          return { ok: false as const, reason: "blocked" as const, message: error.message };
        }
        throw error;
      }
    });

    expect(snapshot.pending).toHaveLength(0);
    expect(snapshot.blocked).toHaveLength(1);
    expect(snapshot.synced).toHaveLength(0);
    expect(count(db, "attempts")).toBe(0);
    expect(count(db, "xp_events")).toBe(0);
    expect(queue.rewards()).toEqual({ eventIds: [], totalXp: 0 });
  });

  it("reloads a persisted queue from storage", () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value);
      },
    };
    const queue = createAttemptQueue(storageQueueStore(storage, "math-sprout-queue"));
    queue.enqueue({
      idempotencyKey: "stored-key-0001",
      childId: "child",
      sessionId: "session",
      itemId: "ops-g2-add",
      answer: "42",
      shownAt: at(0),
      submittedAt: at(2_000),
    });
    const restored = createAttemptQueue(storageQueueStore(storage, "math-sprout-queue"));
    expect(restored.snapshot().pending.map((item) => item.idempotencyKey)).toEqual([
      "stored-key-0001",
    ]);
  });
});

describe("attempt response shape", () => {
  it("includes correct, the four beats, and a soft-state client view", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const result = submitAttempt(db, guardian.id, child.id, input(session.sessionId));

    expect(typeof result.correct).toBe("boolean");
    for (const key of FOUR_BEAT_KEYS) {
      expect(result[key].length).toBeGreaterThan(0);
    }
    expect(Object.keys(result.clientView).sort()).toEqual([
      "bandLabel",
      "celebrationTier",
      "showConceptChip",
    ]);
    expect(result.clientView).toEqual({
      bandLabel: "Getting it",
      showConceptChip: true,
      celebrationTier: "full",
    });
    expect(result.celebrationTier).toBe(result.clientView.celebrationTier);
    expect(result.clientView).not.toHaveProperty("softState");
    expect(result.clientView).not.toHaveProperty("line");
    const dumped = JSON.stringify(result);
    expect(dumped).not.toMatch(/scorePercent|confidence|rawConfidence|percentCorrect/i);
    expect(result).not.toHaveProperty("score");
    expect(result).not.toHaveProperty("confidence");
    expect(result.clientView).not.toHaveProperty("score");
    expect(result.clientView).not.toHaveProperty("confidence");
    expectClientViewSealed(result);

    const log = readAttemptLog(db, result.attemptId);
    expect(log.policyVersion).toBe(POLICY_VERSION);
    expect(log).toMatchObject({
      attemptId: result.attemptId,
      sessionId: session.sessionId,
      idempotencyKey: result.idempotencyKey,
      concept: "adding two-digit numbers",
      itemId: "ops-g2-add",
      difficulty: 2,
      practiceLane: "recommended",
      integrityLane: "celebrate",
      correct: true,
      latencyMs: 2_000,
      clientView: result.clientView,
    });
    expect(JSON.stringify(log)).not.toMatch(/score|confidence|percent/i);
    expect(log).not.toHaveProperty("score");
    expect(log).not.toHaveProperty("confidence");
    const sessionPolicy = db
      .prepare(`SELECT policy_version FROM practice_sessions WHERE id = ?`)
      .get(session.sessionId) as { policy_version: string };
    const attemptPolicy = db
      .prepare(`SELECT policy_version FROM attempts WHERE id = ?`)
      .get(result.attemptId) as { policy_version: string };
    expect(sessionPolicy.policy_version).toBe("rules-v0");
    expect(attemptPolicy.policy_version).toBe("rules-v0");
  });

  it("uses the mastery estimator stub without a numeric score", () => {
    const estimator = new MasteryEstimator();
    const getting = estimator.toClientView({
      correct: true,
      lane: "celebrate",
      celebrationTier: "full",
    });
    const review = estimator.toClientView({
      correct: true,
      lane: "review",
      celebrationTier: "none",
    });
    expect(getting).toEqual({
      bandLabel: "Getting it",
      showConceptChip: true,
      celebrationTier: "full",
    });
    expect(review).toEqual({
      bandLabel: "Still learning",
      showConceptChip: false,
      celebrationTier: "none",
    });
    expect(["Still learning", "Getting it", "Got it"]).toContain(getting.bandLabel);
    expect(["none", "quietXp", "full"]).toContain(review.celebrationTier);
    expect(JSON.stringify(review)).not.toMatch(/score|confidence|percent/i);
  });
});

describe("consent still gates practice", () => {
  it("starts no session when consent is missing, paused, or revoked", () => {
    const db = tempDb();
    const guardian = createGuardian(db, {
      email: "parent@example.com",
      password: "correct-horse",
    });
    const child = createChild(db, guardian.id, { displayName: "Ava" });

    for (const action of [null, "pause", "revoke"] as const) {
      if (action) setConsent(db, guardian.id, child.id, action);
      expect(() => startPracticeSession(db, guardian.id, child.id)).toThrow(DomainError);
      try {
        startPracticeSession(db, guardian.id, child.id);
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).status).toBe(403);
      }
      expect(count(db, "practice_sessions")).toBe(0);
    }

    setConsent(db, guardian.id, child.id, "grant");
    const started = startPracticeSession(db, guardian.id, child.id);
    expect(started.sessionId).toBeTruthy();
    expect(started.item.id).toBe(ITEM_CATALOG[0]?.id);
    expect(count(db, "practice_sessions")).toBe(1);

    const resumed = startPracticeSession(db, guardian.id, child.id);
    expect(resumed.sessionId).toBe(started.sessionId);
    expect(resumed.item.id).toBe(started.item.id);
    expect(count(db, "practice_sessions")).toBe(1);
  });
});

describe("content stub", () => {
  it("includes grades 2–4 operations and a fractions pack", () => {
    assertBankMatchesCatalog();
    const operations = ITEM_CATALOG.filter((item) => item.pack === "operations");
    const fractions = ITEM_CATALOG.filter((item) => item.pack === "fractions");
    expect(new Set(operations.map((item) => item.grade))).toEqual(new Set([2, 3, 4]));
    expect(new Set(fractions.map((item) => item.grade))).toEqual(new Set([2, 3, 4]));
    expect(fractions.length).toBeGreaterThanOrEqual(4);
    for (const item of ITEM_CATALOG) {
      expect(item).not.toHaveProperty("acceptedAnswers");
      expect(item).not.toHaveProperty("answer");
    }
    expect(gradeAnswer("ops-g2-add", "42")).toBe(true);
    expect(gradeAnswer("ops-g2-add", "41")).toBe(false);
    expect(gradeAnswer("frac-g4-add", "3 / 4")).toBe(true);
    expect(gradeAnswer("frac-g4-sub", "2/4")).toBe(true);
  });
});

describe("mint-only ledger", () => {
  it("rejects a negative xp update and has no fuller economy tables", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    submitAttempt(db, guardian.id, child.id, input(session.sessionId));
    expect(() => db.prepare("UPDATE xp_events SET amount = -1").run()).toThrow();
    expect(() => db.prepare("UPDATE xp_events SET amount = 0").run()).toThrow();

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((table) => table.name);
    expect(names).not.toContain("streaks");
    expect(names).not.toContain("shop");
    expect(names).not.toContain("tutor_messages");
    expect(names).not.toContain("wallets");
    expect(xpRows(db).every((row) => row.amount > 0)).toBe(true);
  });
});
