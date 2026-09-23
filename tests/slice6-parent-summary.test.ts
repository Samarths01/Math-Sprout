import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type Database from "better-sqlite3";
import { ParentOneBreathCard } from "@/components/parent-one-breath";
import {
  startPracticeSession,
  submitAttempt,
  type SubmitAttemptInput,
} from "@/lib/attempts";
import { choosePracticeLane, endPracticeSession } from "@/lib/boundary";
import { openDatabase } from "@/lib/db";
import {
  DomainError,
  createChild,
  createGuardian,
  setConsent,
} from "@/lib/domain";
import { canonicalAnswer } from "@/lib/item-bank";
import {
  PARENT_SUMMARY_KEYS,
  glanceBand,
  glanceFocus,
  glanceMinutes,
  readParentSummary,
  type ParentSummary,
} from "@/lib/parent-summary";

const cleanups: Array<() => void> = [];
const NOW = "2026-04-01T20:00:00.000Z";
const NEXT_DAY = "2026-04-02T20:00:00.000Z";

function tempDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-slice6-"));
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

function grantedChild(db: Database.Database, email = "parent@example.com") {
  const guardian = createGuardian(db, {
    email,
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
  shownAt: string,
  submittedAt: string,
  overrides: Partial<SubmitAttemptInput> = {},
): SubmitAttemptInput {
  return {
    idempotencyKey: `slice6-${randomUUID()}`,
    sessionId,
    itemId: "ops-g2-add",
    answer: canonicalAnswer("ops-g2-add"),
    shownAt,
    submittedAt,
    ...overrides,
  };
}

function summaryOf(
  db: Database.Database,
  guardianId: string,
  childId: string,
  now = NOW,
): ParentSummary {
  return readParentSummary(db, guardianId, childId, now);
}

function assertDerivedOnly(summary: ParentSummary, hidden: string[]) {
  expect(Object.keys(summary).sort()).toEqual([...PARENT_SUMMARY_KEYS].sort());
  expect(Object.keys(summary.bandMovement).sort()).toEqual(["from", "moved", "to"]);
  const blob = JSON.stringify(summary);
  for (const word of [
    "attemptId",
    "attempts",
    "idempotencyKey",
    "answer",
    "score",
    "confidence",
    "href",
    "clientView",
    "eventIds",
    "xpAmount",
    "/attempts",
    "%",
  ]) {
    expect(blob, word).not.toContain(word);
  }
  for (const secret of hidden) {
    expect(blob).not.toContain(secret);
  }
  if (summary.bandMovement.to) {
    expect(["Still learning", "Getting it", "Got it"]).toContain(summary.bandMovement.to);
  }
  if (summary.bandMovement.from) {
    expect(["Still learning", "Getting it", "Got it"]).toContain(summary.bandMovement.from);
  }
}

describe("parent one-breath summary", () => {
  it("stays empty when no practice has been committed", () => {
    const db = tempDb();
    const { guardian, child } = grantedChild(db);
    const summary = summaryOf(db, guardian.id, child.id);
    expect(summary).toEqual({
      childId: child.id,
      localDay: "2026-04-01",
      practiced: false,
      minutes: 0,
      focusConcept: null,
      bandMovement: { from: null, to: null, moved: false },
      story: "No practice yet.",
    });
    assertDerivedOnly(summary, []);
    const html = renderToStaticMarkup(createElement(ParentOneBreathCard, { summary }));
    expect(html).toContain("No practice yet.");
    expect(html).not.toContain("href");
    expect(html).not.toContain("→");
    expect(html).not.toMatch(/attempt/i);
  });

  it("reports minutes, the longest concept, and that concept's band movement", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    const short = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(
        session.sessionId,
        "2026-04-01T18:00:00.000Z",
        "2026-04-01T18:01:00.000Z",
        { itemId: "frac-g2-compare", answer: canonicalAnswer("frac-g2-compare") },
      ),
    );
    const long = submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(
        session.sessionId,
        "2026-04-01T18:10:00.000Z",
        "2026-04-01T18:22:00.000Z",
        { answer: "1" },
      ),
    );
    const summary = summaryOf(db, guardian.id, child.id);
    expect(summary.practiced).toBe(true);
    expect(summary.minutes).toBe(13);
    expect(summary.focusConcept).toBe("adding two-digit numbers");
    expect(summary.bandMovement).toEqual({
      from: null,
      to: "Still learning",
      moved: false,
    });
    expect(summary.story).toBe(
      "Today · 13 min. Focus: adding two-digit numbers. Still learning.",
    );
    expect(summary.story).not.toContain("→");
    expect(summary.story).not.toContain("comparing unit fractions");
    expect(summary.story).not.toContain("Got it");
    assertDerivedOnly(summary, [short.attemptId, long.attemptId, short.idempotencyKey]);
    const html = renderToStaticMarkup(createElement(ParentOneBreathCard, { summary }));
    expect(html).toContain("Today · 13 min");
    expect(html).toContain("Focus: adding two-digit numbers");
    expect(html).toContain("Still learning");
    expect(html).not.toContain("href");
    expect(html).not.toContain("→");
    expect(html).not.toContain(short.attemptId);
    expect(html).not.toMatch(/\/attempts|attemptId|score|confidence/i);
  });

  it("shows an arrow only when the focus band moved", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(
        session.sessionId,
        "2026-04-01T18:00:00.000Z",
        "2026-04-01T18:06:00.000Z",
        { answer: "1" },
      ),
    );
    submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(
        session.sessionId,
        "2026-04-01T18:20:00.000Z",
        "2026-04-01T18:26:00.000Z",
      ),
    );
    const summary = summaryOf(db, guardian.id, child.id);
    expect(summary.minutes).toBe(12);
    expect(summary.focusConcept).toBe("adding two-digit numbers");
    expect(summary.bandMovement).toEqual({
      from: "Still learning",
      to: "Getting it",
      moved: true,
    });
    expect(summary.story).toBe(
      "Today · 12 min. Focus: adding two-digit numbers. Still learning → Getting it.",
    );
    expect(glanceMinutes(summary)).toBe("Today · 12 min");
    expect(glanceFocus(summary.focusConcept)).toBe("Focus: adding two-digit numbers");
    expect(glanceBand(summary.bandMovement)).toBe("Still learning → Getting it");
    expect(summary.story).not.toContain("Got it");
  });

  it("can say Got it after recommended evidence, and not after review", () => {
    const db = tempDb();
    const recommended = grantedChild(db, "recommended@example.com");
    const starts = [
      ["2026-04-01T18:00:00.000Z", "2026-04-01T18:00:15.000Z"],
      ["2026-04-01T18:01:00.000Z", "2026-04-01T18:01:15.000Z"],
      ["2026-04-01T18:02:00.000Z", "2026-04-01T18:02:15.000Z"],
    ] as const;
    for (const [shownAt, submittedAt] of starts) {
      submitAttempt(
        db,
        recommended.guardian.id,
        recommended.child.id,
        tryInput(recommended.session.sessionId, shownAt, submittedAt),
      );
    }
    const gotIt = summaryOf(db, recommended.guardian.id, recommended.child.id);
    expect(gotIt.bandMovement).toEqual({
      from: "Getting it",
      to: "Got it",
      moved: true,
    });
    expect(gotIt.story).toBe(
      "Today · under a minute. Focus: adding two-digit numbers. Getting it → Got it.",
    );
    expect(gotIt.minutes).toBe(0);

    const review = grantedChild(db, "review@example.com");
    submitAttempt(
      db,
      review.guardian.id,
      review.child.id,
      tryInput(
        review.session.sessionId,
        "2026-04-01T18:00:00.000Z",
        "2026-04-01T18:00:15.000Z",
        { answer: "1" },
      ),
    );
    endPracticeSession(db, review.guardian.id, review.child.id, review.session.sessionId);
    choosePracticeLane(
      db,
      review.guardian.id,
      review.child.id,
      review.session.sessionId,
      "review",
    );
    const reviewSession = startPracticeSession(db, review.guardian.id, review.child.id);
    expect(reviewSession.lane).toBe("review");
    const reviewTries = [
      ["2026-04-01T18:10:00.000Z", "2026-04-01T18:10:15.000Z"],
      ["2026-04-01T18:11:00.000Z", "2026-04-01T18:11:15.000Z"],
      ["2026-04-01T18:12:00.000Z", "2026-04-01T18:12:15.000Z"],
    ] as const;
    for (const [shownAt, submittedAt] of reviewTries) {
      submitAttempt(
        db,
        review.guardian.id,
        review.child.id,
        tryInput(reviewSession.sessionId, shownAt, submittedAt),
      );
    }
    const held = summaryOf(db, review.guardian.id, review.child.id);
    expect(held.bandMovement.to).not.toBe("Got it");
    expect(held.story).not.toContain("Got it");
    expect(held.bandMovement.to).toBe("Getting it");
  });

  it("does not carry yesterday into today's empty card", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(
        session.sessionId,
        "2026-04-01T18:00:00.000Z",
        "2026-04-01T18:06:00.000Z",
      ),
    );
    const today = summaryOf(db, guardian.id, child.id, NOW);
    expect(today.practiced).toBe(true);
    const next = summaryOf(db, guardian.id, child.id, NEXT_DAY);
    expect(next).toMatchObject({
      localDay: "2026-04-02",
      practiced: false,
      minutes: 0,
      focusConcept: null,
      bandMovement: { from: null, to: null, moved: false },
      story: "No practice yet today.",
    });
    expect(next.story).not.toContain("Getting it");
    expect(next.story).not.toContain("adding two-digit numbers");
  });

  it("keeps pause as a hold and revoke as a block without rewriting the story", () => {
    const db = tempDb();
    const { guardian, child, session } = grantedChild(db);
    submitAttempt(
      db,
      guardian.id,
      child.id,
      tryInput(
        session.sessionId,
        "2026-04-01T18:00:00.000Z",
        "2026-04-01T18:06:00.000Z",
      ),
    );
    const before = summaryOf(db, guardian.id, child.id);
    setConsent(db, guardian.id, child.id, "pause");
    try {
      startPracticeSession(db, guardian.id, child.id);
      throw new Error("paused practice started");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).status).toBe(403);
      expect((error as DomainError).queueDisposition).toBe("hold");
    }
    expect(summaryOf(db, guardian.id, child.id)).toEqual(before);

    setConsent(db, guardian.id, child.id, "revoke");
    try {
      submitAttempt(
        db,
        guardian.id,
        child.id,
        tryInput(
          session.sessionId,
          "2026-04-01T18:30:00.000Z",
          "2026-04-01T18:36:00.000Z",
        ),
      );
      throw new Error("revoked practice was saved");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).status).toBe(403);
      expect((error as DomainError).queueDisposition).toBe("drop");
    }
    expect(summaryOf(db, guardian.id, child.id)).toEqual(before);

    const other = createGuardian(db, {
      email: "other@example.com",
      password: "correct-horse",
    });
    try {
      readParentSummary(db, other.id, child.id, NOW);
      throw new Error("other guardian read the card");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).status).toBe(404);
    }
  });
});
