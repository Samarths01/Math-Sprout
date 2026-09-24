import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type Database from "better-sqlite3";
import { PracticeFeedback } from "@/components/practice-feedback";
import { FuelStrip } from "@/components/fuel-strip";
import { XP_AMOUNT, type AttemptResult } from "@/lib/attempt-contract";
import { startPracticeSession, submitAttempt, type SubmitAttemptInput } from "@/lib/attempts";
import { answerStamp, buildFourBeat } from "@/lib/beats";
import { openDatabase } from "@/lib/db";
import { createChild, createGuardian, setConsent } from "@/lib/domain";
import { feedbackFrames } from "@/lib/feedback-frame";
import { readKidFuel } from "@/lib/fuel";
import { catalogItem } from "@/lib/item-catalog";
import { oneFocusForItem, whyItWorksForItem } from "@/lib/item-bank";
import type { StreakSurface } from "@/lib/companion";

const cleanups: Array<() => void> = [];

function tempDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-dogfood-"));
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

const WHEN = "2026-06-15T18:00:00.000Z";

function view(overrides: Partial<AttemptResult> = {}): AttemptResult {
  const item = catalogItem("ops-g2-add");
  if (!item) throw new Error("missing item");
  return {
    attemptId: "attempt-1",
    idempotencyKey: "key-1",
    replayed: false,
    correct: true,
    whatWentWell: "You worked out adding two-digit numbers.",
    oneFocus: "",
    tryNext: "Try another grade 2 operations problem.",
    lockIn: "27 + 15 = 42",
    celebrationTier: "full",
    lane: "celebrate",
    flags: [],
    eventIds: ["qe-1"],
    xpAmount: XP_AMOUNT.full,
    fuel: { credit: XP_AMOUNT.full, heatEventId: "heat-1", pieceEventIds: [] },
    clientView: {
      bandLabel: "Getting it",
      showConceptChip: true,
      celebrationTier: "full",
    },
    nextItem: item,
    ...overrides,
  };
}

function renderFeedback(result: AttemptResult): string {
  const item = result.nextItem.id === "ops-g2-add" ? result.nextItem : catalogItem(result.nextItem.id);
  return renderToStaticMarkup(
    createElement(PracticeFeedback, {
      feedback: result,
      item: item ?? result.nextItem,
    }),
  );
}

const DORMANT: StreakSurface = {
  state: "dormant",
  copyKey: "streak.dormant",
  emberExpiresAt: null,
  lastQualifyingDay: null,
  sourceEventId: null,
  recovery: null,
};

describe("dogfood verdict and beat frames", () => {
  it("leads with Correct and omits an empty why-it-works beat", () => {
    const item = catalogItem("ops-g2-sub");
    if (!item) throw new Error("missing item");
    expect(whyItWorksForItem(item.id)).toBe("");
    const beats = buildFourBeat({
      correct: true,
      flags: [],
      item,
      canonicalAnswer: "45",
    });
    expect(beats.oneFocus).toBe("");
    expect(beats.lockIn).toBe("63 - 18 = 45");
    expect(beats.lockIn).not.toContain("That is the answer we were looking for");
    const frames = feedbackFrames({ ...beats, correct: true });
    expect(frames.map((frame) => frame.label)).toEqual(["Nice move", "Try next", "Answer"]);
    expect(frames.some((frame) => frame.label === "One focus")).toBe(false);
    expect(frames.some((frame) => frame.label === "Why it works")).toBe(false);

    const html = renderFeedback(
      view({
        ...beats,
        correct: true,
        nextItem: item,
        celebrationTier: "full",
        clientView: {
          bandLabel: "Getting it",
          showConceptChip: true,
          celebrationTier: "full",
        },
      }),
    );
    const verdict = html.indexOf('data-testid="verdict-strip"');
    const firstBeat = html.indexOf('data-testid="beat-whatWentWell"');
    const toast = html.indexOf('data-testid="mint-toast"');
    expect(verdict).toBeGreaterThan(-1);
    expect(verdict).toBeLessThan(firstBeat);
    expect(firstBeat).toBeLessThan(toast);
    expect(html).toContain('data-correct="true"');
    expect(html).toContain("Correct");
    expect(html).toContain("Nice move");
    expect(html).toContain("63 - 18 = 45");
    expect(html).not.toContain("Why it works");
    expect(html).not.toContain("One focus");
    expect(html).not.toContain("Not yet");
    expect(html).not.toMatch(/scorePercent|confidence|%/);
    expect(html).toContain("Getting it");
  });

  it("shows Why it works only from a bank solidify string", () => {
    const item = catalogItem("ops-g2-add");
    if (!item) throw new Error("missing item");
    const solidify = whyItWorksForItem(item.id);
    expect(solidify).toBe("Add the ones first. 7 + 5 is 12, so write 2 and carry 1 ten.");
    const beats = buildFourBeat({
      correct: true,
      flags: [],
      item,
      canonicalAnswer: "42",
    });
    expect(beats.oneFocus).toBe(solidify);
    expect(beats.lockIn).toBe(answerStamp(item.prompt, "42"));
    const html = renderFeedback(view({ ...beats, correct: true, nextItem: item }));
    expect(html).toContain('data-beat-label="Why it works"');
    expect(html).toContain(solidify);
    expect(html).toContain('data-beat-label="Answer"');
    expect(html).toContain("27 + 15 = 42");
    expect(html).not.toContain('data-beat-label="One focus"');
    expect(html).not.toContain("That is the answer we were looking for");
  });

  it("uses the miss frame and still closes with the answer", () => {
    const item = catalogItem("ops-g2-add");
    if (!item) throw new Error("missing item");
    const beats = buildFourBeat({
      correct: false,
      flags: [],
      item,
      canonicalAnswer: "42",
    });
    expect(beats.oneFocus).toBe(oneFocusForItem(item.id));
    expect(beats.lockIn).toBe("27 + 15 = 42");
    const frames = feedbackFrames({ ...beats, correct: false });
    expect(frames.map((frame) => frame.label)).toEqual([
      "What you tried",
      "One focus",
      "Try next",
      "Lock in",
    ]);
    const html = renderFeedback(
      view({
        ...beats,
        correct: false,
        celebrationTier: "quietXp",
        xpAmount: XP_AMOUNT.quietXp,
        eventIds: ["qe-quiet"],
        fuel: { credit: XP_AMOUNT.quietXp, heatEventId: null, pieceEventIds: [] },
        clientView: {
          bandLabel: "Still learning",
          showConceptChip: true,
          celebrationTier: "quietXp",
        },
      }),
    );
    expect(html.indexOf('data-testid="verdict-strip"')).toBeLessThan(
      html.indexOf('data-testid="beat-oneFocus"'),
    );
    expect(html).toContain('data-correct="false"');
    expect(html).toContain("Not yet");
    expect(html).toContain("What you tried");
    expect(html).toContain("Watch regrouping when the ones pass nine.");
    expect(html).toContain('data-beat-label="Lock in"');
    expect(html).toContain("27 + 15 = 42");
    expect(html).toContain("A quiet sprout. This one stays small.");
    expect(html).not.toContain("Nice move");
    expect(html).not.toContain("Why it works");
    expect(html).not.toContain('data-beat-label="Answer"');
    expect(html).not.toContain("text-destructive");
  });

  it("omits an empty diagnostic beat on a miss", () => {
    const frames = feedbackFrames({
      correct: false,
      whatWentWell: "You committed to an answer.",
      oneFocus: "   ",
      tryNext: "Try the next one.",
      lockIn: "1/2",
    });
    expect(frames.map((frame) => frame.label)).toEqual(["What you tried", "Try next", "Lock in"]);
    const item = catalogItem("frac-g2-compare");
    if (!item) throw new Error("missing item");
    const beats = buildFourBeat({
      correct: false,
      flags: [],
      item,
      canonicalAnswer: "1/2",
    });
    expect(beats.lockIn).toBe("1/2");
    expect(beats.oneFocus.length).toBeGreaterThan(0);
  });

  it("fail-closes the toast when the tier is not backed by a mint", () => {
    const html = renderFeedback(
      view({
        celebrationTier: "none",
        xpAmount: 0,
        eventIds: [],
        fuel: { credit: 0, heatEventId: null, pieceEventIds: [] },
        clientView: {
          bandLabel: "Still learning",
          showConceptChip: false,
          celebrationTier: "none",
        },
      }),
    );
    expect(html).toContain("No sprout this time.");
    expect(html).not.toContain("A sprout for that try.");
    expect(html).not.toContain("A piece of the build is in place.");
  });
});

describe("dogfood fuel glance", () => {
  it("keeps the strip under practice and backed by qualifying events", () => {
    const earned = renderToStaticMarkup(
      createElement(FuelStrip, {
        sprout: true,
        piece: {
          eventId: "piece-1",
          kind: "BadgeMilestone",
          role: "badge",
          copyKey: "piece.badge",
          skill: "adding two-digit numbers",
          localDay: "2026-06-15",
          createdAt: WHEN,
        },
        streak: {
          ...DORMANT,
          state: "warm",
          copyKey: "streak.warm",
          lastQualifyingDay: "2026-06-15",
          sourceEventId: "day-1",
        },
      }),
    );
    expect(earned).toContain('data-testid="fuel-strip"');
    expect(earned).toContain('data-fuel-source="qualifying-event"');
    expect(earned).toContain('data-fuel="heat"');
    expect(earned).toContain('data-fuel="xp"');
    expect(earned).toContain('data-fuel="pieces"');
    expect(earned).toContain("Warm");
    expect(earned).toContain("A sprout grew from a careful try.");
    expect(earned).toContain("Badge");
    expect(earned).toContain('data-event-id="piece-1"');
    expect(earned).not.toContain("<a ");
    expect(earned).not.toMatch(/\b\d+\s*xp\b|score|confidence/i);

    const empty = renderToStaticMarkup(
      createElement(FuelStrip, { sprout: false, piece: null, streak: DORMANT }),
    );
    expect(empty).toContain("Quiet");
    expect(empty).toContain("No sprout yet");
    expect(empty).toContain("Open spots");
    expect(empty).not.toContain("A sprout grew from a careful try.");
    expect(empty).toContain('data-backed="false"');

    const childPage = readFileSync(new URL("../app/child/[id]/page.tsx", import.meta.url), "utf8");
    const cta = childPage.indexOf("<PracticeCta");
    const strip = childPage.indexOf("<FuelStrip");
    expect(cta).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(cta);
    const ctaSource = readFileSync(new URL("../components/practice-cta.tsx", import.meta.url), "utf8");
    expect(ctaSource).toContain('className={cn(buttonVariants(), "h-14 w-full text-base")}');
    expect(ctaSource.indexOf("data-testid=\"practice-cta\"")).toBeLessThan(ctaSource.indexOf("{fuel}"));
    expect(existsSync(path.join(process.cwd(), "app/child/[id]/fuel/page.tsx"))).toBe(false);
  });

  it("stores an empty solidify beat and still refuses volume that never mints", () => {
    const db = tempDb();
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
    const shown = new Date(Date.parse(WHEN) - 2_000).toISOString();
    const honest: SubmitAttemptInput = {
      idempotencyKey: randomUUID(),
      sessionId: session.sessionId,
      itemId: "ops-g2-sub",
      answer: "45",
      shownAt: shown,
      submittedAt: WHEN,
    };
    const first = submitAttempt(db, guardian.id, child.id, honest, { now: WHEN });
    expect(first.correct).toBe(true);
    expect(first.oneFocus).toBe("");
    expect(first.lockIn).toBe("63 - 18 = 45");
    expect(first.fuel.credit).toBe(XP_AMOUNT.full);
    expect(first.fuel.heatEventId).toBeTruthy();
    const replay = submitAttempt(db, guardian.id, child.id, honest, { now: WHEN });
    expect(replay.replayed).toBe(true);
    expect(replay.oneFocus).toBe("");
    expect(replay.fuel).toEqual(first.fuel);

    const before = readKidFuel(db, child.id, child.timezone, WHEN);
    const blank = submitAttempt(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "volume-blank",
        sessionId: session.sessionId,
        itemId: "ops-g2-sub",
        answer: "   ",
        shownAt: shown,
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    expect(blank.eventIds).toEqual([]);
    expect(blank.fuel).toEqual({ credit: 0, heatEventId: null, pieceEventIds: [] });
    const after = readKidFuel(db, child.id, child.timezone, WHEN);
    expect(after.accrued).toBe(before.accrued);
    expect(after.heat.state).toBe(before.heat.state);
    expect(after.pieces).toEqual(before.pieces);
    expect(after.heat.sourceEventId).toBe(before.heat.sourceEventId);
  });
});
