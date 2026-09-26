import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  displayedOneFocus,
  FOUR_BEAT_KEYS,
  foldRewards,
  resolveCelebration,
  SPAM_MAX_IN_WINDOW,
  TOO_FAST_MS,
  XP_AMOUNT,
  type AttemptResult,
} from "@/lib/attempt-contract";
import { startPracticeSession, type SubmitAttemptInput } from "@/lib/attempts";
import { submitCatalogAttempt as submitAttempt } from "./catalog-submit";
import { openDatabase } from "@/lib/db";
import { DomainError, createChild, createGuardian, setConsent } from "@/lib/domain";
import { ITEM_CATALOG } from "@/lib/item-catalog";
import {
  assertBankMatchesCatalog,
  gradeAnswer,
  oneFocusForItem,
  tryNextForItem,
  whyItWorksForItem,
} from "@/lib/item-bank";
import { readAttemptLog } from "@/lib/attempt-log";
import { MasteryEstimator } from "@/lib/mastery";
import { POLICY_VERSION } from "@/lib/policy";
import {
  consentQueueReason,
  createAttemptQueue,
  memoryQueueStore,
  OFFLINE_QUEUE_CAP,
  storageQueueStore,
  type QueuedAttempt,
  type SyncPost,
} from "@/lib/offline-queue";
import { readPauseHold, registerPauseHold, showResumeCelebration } from "@/lib/pause-hold";
import { postPauseHoldUntilVisible } from "@/lib/pause-hold-receipt";
import { readOfflineCap, registerOfflineCap } from "@/lib/offline-cap";
import { queueDisposition } from "@/lib/practice-gate";
import { interfaceCopy } from "@/lib/interface-copy";

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

function count(
  db: Database.Database,
  table: "attempts" | "xp_events" | "practice_sessions" | "qualifying_events",
) {
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
  expect(view).not.toMatch(/%|score|confidence|percent|judgment|judgement/i);
  expect(result.clientView).not.toHaveProperty("score");
  expect(result.clientView).not.toHaveProperty("confidence");
  expect(result.clientView).not.toHaveProperty("scorePercent");
  expect(result.clientView).not.toHaveProperty("judgment");
  expect(result).not.toHaveProperty("score");
  expect(result).not.toHaveProperty("confidence");
  expect(result).not.toHaveProperty("policyVersion");
  expect(JSON.stringify(result)).not.toMatch(
    /scorePercent|confidence|rawConfidence|percentCorrect/i,
  );
  expect(JSON.stringify(result)).not.toMatch(/build_sha|policy_version|buildSha|policyVersion/);
}

function xpRows(db: Database.Database) {
  return db
    .prepare(
      `SELECT id, attempt_id, amount, celebration_tier, qualifying_event_id
       FROM xp_events ORDER BY minted_at ASC, id ASC`,
    )
    .all() as Array<{
    id: string;
    attempt_id: string;
    amount: number;
    celebration_tier: string;
    qualifying_event_id: string;
  }>;
}

function qualifyingIds(db: Database.Database, attemptId: string): string[] {
  return (
    db
      .prepare(
        `SELECT id FROM qualifying_events WHERE attempt_id = ? ORDER BY rowid ASC`,
      )
      .all(attemptId) as Array<{ id: string }>
  ).map((row) => row.id);
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
    expect(replay.eventIds).toEqual(qualifyingIds(db, first.attemptId));
    expect(replay.eventIds.length).toBeGreaterThan(0);
    expect(replay.correct).toBe(true);
    expect(replay.celebrationTier).toBe(first.celebrationTier);
    expect(replay.xpAmount).toBe(first.xpAmount);
    expect(replay.whatWentWell).toBe(first.whatWentWell);
    expectClientViewSealed(replay);
    expect(replay.clientView).toEqual(first.clientView);
    expect(count(db, "attempts")).toBe(1);
    expect(count(db, "xp_events")).toBe(1);
    expect(first.eventIds).toContain(xpRows(db)[0]?.qualifying_event_id);
    expect(first.eventIds).not.toContain(xpRows(db)[0]?.id);
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

  it("puts only identical spam into quietXp", () => {
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
    const answers = db
      .prepare(`SELECT answer FROM attempts WHERE child_id = ?`)
      .all(child.id) as Array<{ answer: string }>;
    expect(answers.length).toBe(SPAM_MAX_IN_WINDOW + 1);
    expect(new Set(answers.map((row) => row.answer))).toEqual(new Set(["42"]));
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
        `SELECT a.celebration_tier AS attempt_tier, e.celebration_tier AS event_tier,
                e.amount, e.id, e.qualifying_event_id
         FROM attempts a JOIN xp_events e ON e.attempt_id = a.id
         WHERE a.id = ?`,
      )
      .get(result.attemptId) as {
      attempt_tier: string;
      event_tier: string;
      amount: number;
      id: string;
      qualifying_event_id: string;
    };

    expect(row.attempt_tier).toBe("full");
    expect(row.event_tier).toBe("full");
    expect(row.amount).toBe(XP_AMOUNT.full);
    expect(result.eventIds).toEqual(qualifyingIds(db, result.attemptId));
    expect(result.eventIds).toContain(row.qualifying_event_id);
    expect(result.eventIds).not.toContain(row.id);
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
    await queue.enqueue(first);
    await queue.enqueue(second);

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
    await queue.enqueue(attempt);
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
    expect(synced.synced[0]?.eventIds.length).toBeGreaterThan(0);
    const credit = db
      .prepare(`SELECT id, qualifying_event_id FROM xp_events`)
      .get() as { id: string; qualifying_event_id: string };
    expect(synced.synced[0]?.eventIds).toContain(credit.qualifying_event_id);
    expect(synced.synced[0]?.eventIds).not.toContain(credit.id);
    expect(count(db, "xp_events")).toBe(1);
  });

  it("retries a pause-hold receipt and keeps hold when every post fails", async () => {
    const wait = async () => {};
    let calls = 0;
    const visible = await postPauseHoldUntilVisible(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("receipt missed");
        return true;
      },
      { tries: 4, wait },
    );
    expect(visible).toBe(true);
    expect(calls).toBe(3);

    let misses = 0;
    const stillHeld = await postPauseHoldUntilVisible(
      async () => {
        misses += 1;
        return false;
      },
      { tries: 4, wait },
    );
    expect(stillHeld).toBe(false);
    expect(misses).toBe(4);
    expect(consentQueueReason({ queueDisposition: "hold" })).toBe("hold");
  });

  it("holds a paused queue where a parent can see it and credits it quietly", async () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const queue = createAttemptQueue(memoryQueueStore());
    const attempt = {
      idempotencyKey: "paused-key-0001",
      childId: child.id,
      sessionId: session.sessionId,
      itemId: "ops-g2-add",
      answer: "42",
      shownAt: at(0),
      submittedAt: at(2_000),
    };
    const second = {
      ...attempt,
      idempotencyKey: "paused-key-0002",
      submittedAt: at(4_000),
    };
    await queue.enqueue(attempt);
    await queue.enqueue(second);
    setConsent(db, guardian.id, child.id, "pause");
    expect(queueDisposition("paused")).toBe("hold");
    expect(queueDisposition("revoked")).toBe("drop");
    expect(queueDisposition("none")).toBe("drop");
    expect(
      consentQueueReason({
        queueDisposition: "hold",
        error: "Practice is paused. A parent can grant consent again from the parent home.",
      }),
    ).toBe("hold");
    expect(consentQueueReason({ queueDisposition: "drop" })).toBe("drop");
    expect(consentQueueReason(null)).toBe("drop");

    const pauseOnly = createAttemptQueue(memoryQueueStore());
    await pauseOnly.enqueue(attempt);
    const stillHeld = await pauseOnly.reconcile(async () => ({
      ok: false as const,
      reason: consentQueueReason({ queueDisposition: "hold" }),
      message: "Practice is paused.",
    }));
    expect(stillHeld.pending.map((item) => item.idempotencyKey)).toEqual(["paused-key-0001"]);
    expect(stillHeld.dropped).toEqual([]);
    expect(stillHeld.held).toBe(1);
    expect(count(db, "attempts")).toBe(0);

    const post = async (queued: QueuedAttempt): Promise<SyncPost> => {
      try {
        return { ok: true, result: submitAttempt(db, guardian.id, child.id, queued) };
      } catch (error) {
        if (error instanceof DomainError && error.status === 403) {
          if (error.queueDisposition === "hold") {
            registerPauseHold(db, guardian.id, child.id, queued);
          }
          return {
            ok: false,
            reason: consentQueueReason({
              error: error.message,
              queueDisposition: error.queueDisposition,
            }),
            message: error.message,
          };
        }
        throw error;
      }
    };

    const held = await queue.reconcile(post);
    expect(held.pending.map((item) => item.idempotencyKey)).toEqual([
      "paused-key-0001",
      "paused-key-0002",
    ]);
    expect(held.synced).toEqual([]);
    expect(held.dropped).toEqual([]);
    expect(held.held).toBe(2);
    expect(count(db, "attempts")).toBe(0);
    expect(count(db, "xp_events")).toBe(0);
    expect(count(db, "qualifying_events")).toBe(0);
    const waiting = readPauseHold(db, guardian.id, child.id);
    expect(waiting).toEqual({
      visible: true,
      waiting: 2,
      copyKey: "pause.hold.waiting",
      detailKey: "pause.hold.waiting.detail",
    });
    expect(waiting).not.toHaveProperty("answer");
    const storedHold = db
      .prepare(`SELECT hold_json FROM consents WHERE child_id = ?`)
      .get(child.id) as { hold_json: string };
    const stored = JSON.parse(storedHold.hold_json) as {
      pending: Array<Record<string, string>>;
    };
    expect(stored.pending).toEqual([
      { idempotencyKey: "paused-key-0001", sessionId: session.sessionId },
      { idempotencyKey: "paused-key-0002", sessionId: session.sessionId },
    ]);
    expect(stored.pending.every((item) => !("answer" in item))).toBe(true);

    expect(() => registerPauseHold(db, guardian.id, child.id, attempt)).not.toThrow();
    setConsent(db, guardian.id, child.id, "grant");
    expect(readPauseHold(db, guardian.id, child.id)).toEqual({
      visible: true,
      waiting: 2,
      copyKey: "pause.hold.resuming",
      detailKey: "pause.hold.waiting.detail",
    });
    expect(() => registerPauseHold(db, guardian.id, child.id, attempt)).toThrow(DomainError);
    const resumed = await queue.reconcile(post);
    expect(resumed.pending).toEqual([]);
    expect(resumed.dropped).toEqual([]);
    expect(resumed.quietCredits).toBe(2);
    expect(resumed.synced).toHaveLength(2);
    for (const result of resumed.synced) {
      expect(result.resumePresentation).toBe("quiet");
      expect(result.celebrationTier).toBe("full");
      expect(result.clientView.celebrationTier).toBe("full");
      expect(showResumeCelebration(result)).toBe(false);
      expectClientViewSealed(result);
    }
    expect(count(db, "attempts")).toBe(2);
    expect(count(db, "xp_events")).toBe(2);
    expect(readPauseHold(db, guardian.id, child.id)).toBeNull();
    const replay = submitAttempt(db, guardian.id, child.id, attempt);
    expect(replay.replayed).toBe(true);
    expect(replay.resumePresentation).toBe("quiet");
    expect(showResumeCelebration(replay)).toBe(false);
    expect(count(db, "xp_events")).toBe(2);

    const emptyPause = readPauseHold(db, guardian.id, child.id);
    expect(emptyPause).toBeNull();
    setConsent(db, guardian.id, child.id, "pause");
    expect(readPauseHold(db, guardian.id, child.id)).toEqual({
      visible: true,
      waiting: 0,
      copyKey: "pause.hold.empty",
      detailKey: "pause.hold.waiting.detail",
    });
  });

  it("drops a revoked queue and never syncs it", async () => {
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
    await queue.enqueue(attempt);
    setConsent(db, guardian.id, child.id, "pause");
    registerPauseHold(db, guardian.id, child.id, attempt);
    expect(readPauseHold(db, guardian.id, child.id)?.waiting).toBe(1);
    setConsent(db, guardian.id, child.id, "revoke");
    expect(readPauseHold(db, guardian.id, child.id)).toBeNull();
    const storedHold = db
      .prepare(`SELECT hold_json FROM consents WHERE child_id = ?`)
      .get(child.id) as { hold_json: string | null };
    expect(storedHold.hold_json).toBeNull();

    const snapshot = await queue.reconcile(async (queued) => {
      try {
        return {
          ok: true as const,
          result: submitAttempt(db, guardian.id, child.id, queued),
        };
      } catch (error) {
        if (error instanceof DomainError && error.queueDisposition) {
          return { ok: false as const, reason: error.queueDisposition, message: error.message };
        }
        throw error;
      }
    });

    expect(snapshot.pending).toEqual([]);
    expect(snapshot.synced).toEqual([]);
    expect(snapshot.dropped).toEqual([
      {
        idempotencyKey: "revoked-key-001",
        childId: child.id,
        sessionId: session.sessionId,
      },
    ]);
    expect(Object.keys(snapshot.dropped[0] ?? {}).sort()).toEqual([
      "childId",
      "idempotencyKey",
      "sessionId",
    ]);
    expect(snapshot.dropped[0]).not.toHaveProperty("answer");
    expect(snapshot.dropped[0]).not.toHaveProperty("itemId");
    expect(count(db, "attempts")).toBe(0);
    expect(count(db, "xp_events")).toBe(0);
    expect(count(db, "qualifying_events")).toBe(0);
    expect(queue.rewards()).toEqual({ eventIds: [], totalXp: 0 });

    setConsent(db, guardian.id, child.id, "grant");
    await queue.enqueue(attempt);
    const again = await queue.reconcile(async (queued) => ({
      ok: true as const,
      result: submitAttempt(db, guardian.id, child.id, queued),
    }));
    expect(again.pending).toEqual([]);
    expect(again.synced).toEqual([]);
    expect(count(db, "attempts")).toBe(0);
  });

  it("caps the unsynced queue so offline tries stay short", async () => {
    const queue = createAttemptQueue(memoryQueueStore());
    const attempts = Array.from({ length: OFFLINE_QUEUE_CAP }, (_, index) => ({
      idempotencyKey: `cap-key-${index}0001`,
      childId: "child",
      sessionId: "session",
      itemId: "ops-g2-add",
      answer: "42",
      shownAt: at(0),
      submittedAt: at(2_000 + index),
    }));
    for (const attempt of attempts) await queue.enqueue(attempt);
    const overflow = await queue.enqueue({
      ...attempts[0],
      idempotencyKey: "cap-key-overflow",
      submittedAt: at(9_000),
    });
    expect(overflow.capped).toBe(true);
    expect(overflow.pending).toHaveLength(OFFLINE_QUEUE_CAP);
    expect(overflow.pending.map((item) => item.idempotencyKey)).not.toContain("cap-key-overflow");
    const again = await queue.enqueue(attempts[0]);
    expect(again.capped).toBeUndefined();
    expect(again.pending).toHaveLength(OFFLINE_QUEUE_CAP);
  });

  it("shows a full offline cap as a sync limit a parent can see", () => {
    const db = tempDb();
    const { guardian, child } = grantedChild(db);
    expect(readOfflineCap(db, guardian.id, child.id)).toBeNull();

    const view = registerOfflineCap(db, guardian.id, child.id, OFFLINE_QUEUE_CAP);
    expect(view).toEqual({
      visible: true,
      waiting: OFFLINE_QUEUE_CAP,
      copyKey: "offline.cap.waiting",
      detailKey: "offline.cap.detail",
    });
    if (!("copyKey" in view)) throw new Error("expected a visible cap");
    const lines = [
      interfaceCopy(view.copyKey),
      interfaceCopy(view.detailKey),
      interfaceCopy("offline.cap.kid"),
    ];
    for (const line of lines) {
      expect(line.toLowerCase()).not.toContain("paused");
      expect(line.toLowerCase()).not.toContain("revoked");
    }
    const stored = db
      .prepare(`SELECT offline_cap_json FROM consents WHERE child_id = ?`)
      .get(child.id) as { offline_cap_json: string };
    expect(JSON.parse(stored.offline_cap_json)).toEqual({ waiting: OFFLINE_QUEUE_CAP });
    expect(stored.offline_cap_json).not.toContain("answer");

    setConsent(db, guardian.id, child.id, "pause");
    expect(readOfflineCap(db, guardian.id, child.id)).toBeNull();
    expect(() => registerOfflineCap(db, guardian.id, child.id, OFFLINE_QUEUE_CAP)).toThrow(
      DomainError,
    );

    setConsent(db, guardian.id, child.id, "grant");
    expect(readOfflineCap(db, guardian.id, child.id)?.waiting).toBe(OFFLINE_QUEUE_CAP);
    expect(registerOfflineCap(db, guardian.id, child.id, 0)).toEqual({
      visible: false,
      waiting: 0,
    });
    const cleared = db
      .prepare(`SELECT offline_cap_json FROM consents WHERE child_id = ?`)
      .get(child.id) as { offline_cap_json: string | null };
    expect(cleared.offline_cap_json).toBeNull();

    registerOfflineCap(db, guardian.id, child.id, 9);
    setConsent(db, guardian.id, child.id, "revoke");
    const revoked = db
      .prepare(`SELECT offline_cap_json FROM consents WHERE child_id = ?`)
      .get(child.id) as { offline_cap_json: string | null };
    expect(revoked.offline_cap_json).toBeNull();
  });

  it("does not promote a band while the attempt is only queued", async () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const queue = createAttemptQueue(memoryQueueStore());
    const attempt = {
      ...input(session.sessionId, { idempotencyKey: "offline-band-0001" }),
      childId: child.id,
    };
    await queue.enqueue(attempt);
    const offline = await queue.reconcile(async () => ({ ok: false as const, reason: "offline" }));
    expect(offline.pending).toHaveLength(1);
    expect(count(db, "attempts")).toBe(0);
    expect(count(db, "xp_events")).toBe(0);
    expect(count(db, "qualifying_events")).toBe(0);
    const bands = db.prepare(`SELECT COUNT(*) AS count FROM learner_skill_state`).get() as {
      count: number;
    };
    expect(bands.count).toBe(0);

    const synced = await queue.reconcile(async (queued) => ({
      ok: true as const,
      result: submitAttempt(db, guardian.id, child.id, queued),
    }));
    expect(synced.pending).toEqual([]);
    expect(synced.synced[0]?.clientView.bandLabel).toBe("Getting it");
    expect(synced.synced[0]?.celebrationTier).toBe(synced.synced[0]?.clientView.celebrationTier);
    expect(synced.synced[0]?.correct).toBe(true);
    expect(synced.synced[0]?.oneFocus).toBe(whyItWorksForItem(attempt.itemId));
    expect(displayedOneFocus(synced.synced[0]!)).toBe(synced.synced[0]?.oneFocus);
    const stored = db
      .prepare(`SELECT band_label FROM learner_skill_state WHERE child_id = ?`)
      .get(child.id) as { band_label: string };
    expect(stored.band_label).toBe("Getting it");
  });

  it("reloads a persisted queue from storage", async () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value);
      },
    };
    const queue = createAttemptQueue(storageQueueStore(storage, "math-sprout-queue"));
    await queue.enqueue({
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

  it("strips a stored answer when a blocked queue is reloaded", () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value);
      },
    };
    saved.set(
      "math-sprout-queue",
      JSON.stringify({
        version: 1,
        pending: [],
        blocked: [
          {
            idempotencyKey: "old-blocked-001",
            childId: "child",
            sessionId: "session",
            itemId: "ops-g2-add",
            answer: "42",
            shownAt: at(0),
            submittedAt: at(2_000),
            message: "Practice is blocked because a parent revoked consent.",
          },
        ],
        synced: [],
      }),
    );
    const restored = createAttemptQueue(storageQueueStore(storage, "math-sprout-queue"));
    expect(restored.snapshot().pending).toEqual([]);
    expect(restored.snapshot().dropped).toEqual([
      { idempotencyKey: "old-blocked-001", childId: "child", sessionId: "session" },
    ]);
    expect(JSON.stringify(restored.snapshot().dropped)).not.toContain("42");
  });
});

describe("attempt response shape", () => {
  it("includes correct, the four beats, and a soft-state client view", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const result = submitAttempt(db, guardian.id, child.id, input(session.sessionId));

    expect(typeof result.correct).toBe("boolean");
    expect(result.correct).toBe(true);
    for (const key of FOUR_BEAT_KEYS) {
      expect(typeof result[key]).toBe("string");
    }
    expect(result.lockIn).toBe("27 + 15 = 42");
    expect(result.lockIn).not.toContain("That is the answer we were looking for");
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
    expect(result.oneFocus).toBe(whyItWorksForItem("ops-g2-add"));
    expect(displayedOneFocus(result)).toBe(result.oneFocus);
    expect(result.oneFocus).toBe("Add the ones first. 7 + 5 is 12, so write 2 and carry 1 ten.");
    expect(result.oneFocus).not.toMatch(/keep reading|look again|great job|awesome/i);
    const missed = submitAttempt(
      db,
      guardian.id,
      child.id,
      input(session.sessionId, { idempotencyKey: "focus-miss-0001", answer: "41" }),
    );
    expect(missed.correct).toBe(false);
    expect(missed.oneFocus).toBe(oneFocusForItem("ops-g2-add"));
    expect(displayedOneFocus(missed)).toBe(missed.oneFocus);
    expect(missed.oneFocus).toBe("Watch regrouping when the ones pass nine.");
    expect(missed.oneFocus).not.toBe(result.oneFocus);
    expect(missed.lockIn).toBe("27 + 15 = 42");
    expect(missed.tryNext).toBe(tryNextForItem("ops-g2-add"));
    const blank = submitAttempt(
      db,
      guardian.id,
      child.id,
      input(session.sessionId, { idempotencyKey: "focus-blank-001", answer: "" }),
    );
    expect(blank.oneFocus).toBe("Write an answer before you check.");
    for (const item of ITEM_CATALOG) {
      expect(item).not.toHaveProperty("misconception");
      expect(item).not.toHaveProperty("oneFocus");
    }
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
