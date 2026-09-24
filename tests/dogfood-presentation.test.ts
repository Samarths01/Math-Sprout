import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type Database from "better-sqlite3";
import { ChildHomeFrame } from "@/components/child-home";
import { FuelStrip } from "@/components/fuel-strip";
import { ParentOneBreathCard } from "@/components/parent-one-breath";
import { PracticeFeedback } from "@/components/practice-feedback";
import { XP_AMOUNT, type AttemptResult } from "@/lib/attempt-contract";
import { startPracticeSession, submitAttempt, type SubmitAttemptInput } from "@/lib/attempts";
import { answerStamp, buildFourBeat } from "@/lib/beats";
import { choosePracticeLane, endPracticeSession } from "@/lib/boundary";
import { projectBuildGoal } from "@/lib/build-goal";
import { readCompanion, type CompanionGlance } from "@/lib/companion";
import { openDatabase } from "@/lib/db";
import { createChild, createGuardian, setConsent } from "@/lib/domain";
import { projectFlameRun } from "@/lib/flame-run";
import { feedbackFrames } from "@/lib/feedback-frame";
import { accruedXp, loadQualifyingDays, projectHeat, readKidFuel } from "@/lib/fuel";
import { consumeFuelPulse, markFuelPulse, releaseFuelPulse, shouldPulseFuelStrip } from "@/lib/fuel-motion";
import { fuelStripText, readChildFocus } from "@/lib/home-presentation";
import { interfaceCopy } from "@/lib/interface-copy";
import { catalogItem } from "@/lib/item-catalog";
import { oneFocusForItem, whyItWorksForItem } from "@/lib/item-bank";
import { readParentSummary } from "@/lib/parent-summary";

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

const GLANCE: CompanionGlance = { xp: 120, dayCount: 3, pieces: 2, goal: 5 };

function homeHtml(overrides: Partial<Parameters<typeof ChildHomeFrame>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ChildHomeFrame, {
      childId: "child-1",
      displayName: "Leo",
      concept: "Adding two-digit numbers",
      bandLabel: "Getting it",
      consentStatus: "granted",
      glance: GLANCE,
      started: true,
      sourceEventId: "day-3",
      ...overrides,
    }),
  );
}

describe("dogfood fuel glance", () => {
  it("keeps one numeric strip under the only practice control", () => {
    const earned = renderToStaticMarkup(
      createElement(FuelStrip, {
        childId: "child-1",
        text: "🔥 3-day flame · ⭐ 120 XP · 🧩 2/5",
        xp: 120,
        dayCount: 3,
        pieces: 2,
        goal: 5,
        flame: "lit",
        sourceEventId: "day-3",
      }),
    );
    expect(earned).toContain('data-testid="fuel-strip"');
    expect(earned).toContain('data-fuel-source="qualifying-event"');
    expect(earned).toContain("🔥 3-day flame · ⭐ 120 XP · 🧩 2/5");
    expect(earned).not.toContain("<a ");
    expect(earned).not.toContain("<button");
    expect(earned).not.toMatch(/score|confidence/i);

    const homeFrame = readFileSync(new URL("../components/child-home.tsx", import.meta.url), "utf8");
    const cta = homeFrame.indexOf("<PracticeCta");
    const strip = homeFrame.indexOf("<FuelStrip");
    expect(cta).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(cta);
    const ctaSource = readFileSync(new URL("../components/practice-cta.tsx", import.meta.url), "utf8");
    expect(ctaSource).toContain('className={cn(buttonVariants(), "h-14 w-full text-base")}');
    expect(existsSync(path.join(process.cwd(), "app/child/[id]/fuel/page.tsx"))).toBe(false);
    expect(existsSync(path.join(process.cwd(), "components/companion-state.tsx"))).toBe(false);
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

function orderOf(html: string, testId: string): number {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at, testId).toBeGreaterThan(-1);
  return at;
}

describe("child home presentation", () => {
  it("shows exactly one practice CTA with the numeric strip under it", () => {
    const html = homeHtml();
    expect(html.match(/data-testid="practice-cta"/g)).toHaveLength(1);
    expect(html.match(/Start practice/g)).toHaveLength(1);
    expect(html).not.toContain("ember-recovery");
    expect(html).not.toContain("Practice today to warm the flame");
    expect(html).toContain("🔥 3-day flame · ⭐ 120 XP · 🧩 2/5");
    expect(orderOf(html, "child-greeting")).toBeLessThan(orderOf(html, "focus-label"));
    expect(orderOf(html, "focus-label")).toBeLessThan(orderOf(html, "focus-concept"));
    expect(orderOf(html, "focus-concept")).toBeLessThan(orderOf(html, "focus-band"));
    expect(orderOf(html, "focus-band")).toBeLessThan(orderOf(html, "practice-cta"));
    expect(orderOf(html, "practice-cta")).toBeLessThan(orderOf(html, "fuel-strip"));
    expect(orderOf(html, "fuel-strip")).toBeLessThan(orderOf(html, "badge-link"));
    expect(html).toContain("Hi, Leo");
    expect(html).toMatch(/TODAY(?:&#x27;|')S FOCUS/);
    expect(html).toContain("Adding two-digit numbers");
    expect(html).toContain("Getting it");
    expect(html).toContain("Badges ›");
    expect(html).toContain('href="/child/child-1/badges"');
    const stripStart = html.indexOf('<p data-testid="fuel-strip"');
    const stripEnd = html.indexOf("</p>", stripStart);
    expect(stripStart).toBeGreaterThan(-1);
    expect(html.slice(stripStart, stripEnd)).not.toContain("<a");
    expect(html.slice(stripStart, stripEnd)).not.toContain("<button");
  });

  it("uses Flame resting when the flame has cooled, and a start line before the first qualifying day", () => {
    const resting = homeHtml({
      glance: { xp: 5, dayCount: null, pieces: 0, goal: 3 },
      started: true,
      sourceEventId: null,
    });
    expect(resting).toContain("🔥 Flame resting · ⭐ 5 XP · 🧩 0/3");
    expect(resting).not.toContain("0-day");
    expect(resting).not.toMatch(/🔥 0/);

    const fresh = homeHtml({
      glance: { xp: 0, dayCount: null, pieces: 0, goal: 3 },
      started: false,
      sourceEventId: null,
      bandLabel: "Still learning",
    });
    expect(fresh).toContain("🔥 Start your flame · ⭐ 0 XP · 🧩 0/3");
    expect(fresh).toContain('data-testid="fuel-strip"');
  });

  it("keeps consent copy and empty pot slots off a granted home", () => {
    const html = homeHtml();
    expect(html).not.toMatch(/consent/i);
    expect(html).not.toContain("Only a parent can allow practice");
    expect(html).not.toContain("A parent has granted consent");
    expect(html).not.toContain("Still open");
    expect(html).not.toContain('data-testid="build-slot"');
    expect(html).not.toContain("The flame is");

    const childPage = readFileSync(new URL("../app/child/[id]/page.tsx", import.meta.url), "utf8");
    expect(childPage).not.toContain("Only a parent can allow practice");
    expect(childPage).not.toContain("StatusPill");
    const parentPage = readFileSync(new URL("../app/parent/page.tsx", import.meta.url), "utf8");
    expect(parentPage).toContain('interfaceCopy("parent.consent.line")');
    expect(interfaceCopy("parent.consent.line")).toBe(
      "Only a parent can allow practice. Missing, paused, or revoked consent does not start a session.",
    );
    const consentUses = parentPage.match(/interfaceCopy\("parent\.consent\.line"\)/g) ?? [];
    expect(consentUses).toHaveLength(1);
  });

  it("replaces the CTA with calm pause copy and leaves the strip in place", () => {
    const html = homeHtml({
      consentStatus: "paused",
      glance: { xp: 5, dayCount: 1, pieces: 0, goal: 3 },
    });
    expect(html).not.toContain('data-testid="practice-cta"');
    expect(html).not.toContain("Start practice");
    expect(html).toContain("Practice is paused for now — ask your grown-up.");
    expect(html).toContain("🔥 1-day flame · ⭐ 5 XP · 🧩 0/3");
    expect(orderOf(html, "practice-blocked")).toBeLessThan(orderOf(html, "fuel-strip"));

    const revoked = homeHtml({ consentStatus: "revoked" });
    expect(revoked).not.toContain('data-testid="practice-cta"');
    expect(revoked).toContain("Practice is closed for now — ask your grown-up.");
    expect(revoked).toContain('data-testid="fuel-strip"');
  });

  it("keeps offline cap copy free of the word paused", () => {
    for (const key of ["offline.cap.kid", "offline.cap.waiting", "offline.cap.detail"] as const) {
      expect(interfaceCopy(key).toLowerCase()).not.toContain("paused");
    }
    expect(interfaceCopy("home.block.paused").toLowerCase()).toContain("paused");
    expect(interfaceCopy("offline.cap.kid")).not.toContain("Practice is paused");
    const practice = readFileSync(
      new URL("../components/practice-session.tsx", import.meta.url),
      "utf8",
    );
    expect(practice).toContain('interfaceCopy("offline.cap.kid")');
    expect(practice).not.toContain("Practice is paused for now");
  });

  it("pulses the strip once after a mint toast and not after a replay", () => {
    const storage = new Map<string, string>();
    const fake = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    };
    expect(
      shouldPulseFuelStrip({
        tier: "full",
        credit: XP_AMOUNT.full,
        eventCount: 1,
        replayed: false,
        resumeQuiet: false,
      }),
    ).toBe(true);
    expect(
      markFuelPulse(fake, "child-1", {
        tier: "full",
        credit: XP_AMOUNT.full,
        eventCount: 1,
        replayed: true,
        resumeQuiet: false,
        eventId: "qe-1",
      }),
    ).toBe(false);
    expect(
      markFuelPulse(fake, "child-1", {
        tier: "none",
        credit: 0,
        eventCount: 0,
        replayed: false,
        resumeQuiet: false,
        eventId: null,
      }),
    ).toBe(false);
    expect(
      markFuelPulse(fake, "child-1", {
        tier: "full",
        credit: XP_AMOUNT.full,
        eventCount: 1,
        replayed: false,
        resumeQuiet: true,
        eventId: "qe-1",
      }),
    ).toBe(false);
    expect(
      markFuelPulse(fake, "child-1", {
        tier: "full",
        credit: XP_AMOUNT.full,
        eventCount: 2,
        replayed: false,
        resumeQuiet: false,
        eventId: "qe-1",
      }),
    ).toBe(true);
    expect(consumeFuelPulse(fake, "child-1")).toBe(true);
    expect(fake.getItem("math-sprout:fuel-pulse:child-1")).toBeNull();
    expect(consumeFuelPulse(fake, "child-1")).toBe(true);
    releaseFuelPulse("child-1");
    expect(consumeFuelPulse(fake, "child-1")).toBe(false);

    const pulsed = renderToStaticMarkup(
      createElement(FuelStrip, {
        childId: "child-1",
        text: "🔥 1-day flame · ⭐ 5 XP · 🧩 0/3",
        xp: 5,
        dayCount: 1,
        pieces: 0,
        goal: 3,
        flame: "lit",
        sourceEventId: "day-1",
        forcePulse: true,
      }),
    );
    expect(pulsed).toContain('data-pulse="once"');
    expect(pulsed).toContain("fuel-strip-pulse");
  });

  it("matches strip numbers to bus projections, including volume that never qualifies", () => {
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

    const fresh = readCompanion(db, child.id, WHEN);
    expect(fresh.streak.lastQualifyingDay).toBeNull();
    expect(fresh.glance).toEqual({ xp: 0, dayCount: null, pieces: 0, goal: 3 });
    expect(
      fuelStripText({
        started: false,
        dayCount: fresh.glance.dayCount,
        xp: fresh.glance.xp,
        pieces: fresh.glance.pieces,
        goal: fresh.glance.goal,
      }),
    ).toBe("🔥 Start your flame · ⭐ 0 XP · 🧩 0/3");
    expect(readChildFocus(db, child.id)).toEqual({
      concept: "Adding two-digit numbers",
      bandLabel: "Still learning",
    });

    const days = [
      "2026-06-15T18:00:00.000Z",
      "2026-06-16T18:00:00.000Z",
      "2026-06-17T18:00:00.000Z",
    ];
    for (const [index, when] of days.entries()) {
      const session = startPracticeSession(db, guardian.id, child.id);
      submitAttempt(
        db,
        guardian.id,
        child.id,
        {
          idempotencyKey: `qualifying-day-${index}`,
          sessionId: session.sessionId,
          itemId: "ops-g2-add",
          answer: "42",
          shownAt: new Date(Date.parse(when) - 2_000).toISOString(),
          submittedAt: when,
        },
        { now: when },
      );
      endPracticeSession(db, guardian.id, child.id, session.sessionId);
      choosePracticeLane(db, guardian.id, child.id, session.sessionId, "recommended");
    }

    const observed = days[2];
    const view = readCompanion(db, child.id, observed);
    const fuel = readKidFuel(db, child.id, child.timezone, observed);
    const build = projectBuildGoal(db, child.id);
    const run = projectFlameRun(loadQualifyingDays(db, child.id), child.timezone, observed);
    expect(run.state).toBe(projectHeat(loadQualifyingDays(db, child.id), child.timezone, observed).state);
    expect(view.glance.xp).toBe(accruedXp(db, child.id));
    expect(view.glance.xp).toBe(fuel.accrued);
    expect(view.glance.pieces).toBe(build.active.pieces.length);
    expect(view.glance.goal).toBe(build.active.pieceTarget);
    expect(view.glance.dayCount).toBe(run.dayCount);
    expect(view.glance.dayCount).toBe(3);
    const line = fuelStripText({
      started: view.streak.lastQualifyingDay !== null,
      dayCount: view.glance.dayCount,
      xp: view.glance.xp,
      pieces: view.glance.pieces,
      goal: view.glance.goal,
    });
    expect(line).toBe(
      `🔥 ${view.glance.dayCount}-day flame · ⭐ ${view.glance.xp} XP · 🧩 ${view.glance.pieces}/${view.glance.goal}`,
    );

    const session = startPracticeSession(db, guardian.id, child.id);
    const beforeGlance = readCompanion(db, child.id, observed).glance;
    submitAttempt(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "volume-no-event",
        sessionId: session.sessionId,
        itemId: "ops-g2-add",
        answer: "   ",
        shownAt: new Date(Date.parse(observed) - 2_000).toISOString(),
        submittedAt: observed,
      },
      { now: observed },
    );
    const after = readCompanion(db, child.id, observed);
    expect(after.glance).toEqual(beforeGlance);
    expect(after.glance.xp).toBe(accruedXp(db, child.id));
    expect(after.glance.dayCount).toBe(
      projectFlameRun(loadQualifyingDays(db, child.id), child.timezone, observed).dayCount,
    );

    const cooled = readCompanion(db, child.id, "2026-06-19T18:00:00.000Z");
    expect(cooled.streak.state).toBe("dormant");
    expect(cooled.streak.lastQualifyingDay).toBe("2026-06-17");
    expect(cooled.glance.dayCount).toBeNull();
    expect(
      fuelStripText({
        started: true,
        dayCount: cooled.glance.dayCount,
        xp: cooled.glance.xp,
        pieces: cooled.glance.pieces,
        goal: cooled.glance.goal,
      }),
    ).toContain("🔥 Flame resting");
    expect(cooled.glance.xp).toBe(view.glance.xp);

    const summary = readParentSummary(db, guardian.id, child.id, observed);
    expect(summary).not.toHaveProperty("xp");
    expect(JSON.stringify(summary)).not.toMatch(/"xp"|xpAmount|\bXP\b/);
    const breath = renderToStaticMarkup(
      createElement(ParentOneBreathCard, { summary }),
    );
    expect(breath).not.toMatch(/\bXP\b|xpAmount/);
    expect(breath).toContain("adding two-digit numbers");
  });
});
