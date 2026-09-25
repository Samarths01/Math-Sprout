import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type Database from "better-sqlite3";
import { MintToast } from "@/components/mint-toast";
import { ParentOneBreathCard } from "@/components/parent-one-breath";
import { PracticeFeedback } from "@/components/practice-feedback";
import { XP_AMOUNT, type AttemptResult, type ClientView } from "@/lib/attempt-contract";
import { parseSubmitAttempt, startPracticeSession } from "@/lib/attempts";
import { submitCatalogAttempt as submitAttempt } from "./catalog-submit";
import { choosePracticeLane, endPracticeSession } from "@/lib/boundary";
import { readCompanion } from "@/lib/companion";
import { openDatabase } from "@/lib/db";
import { createChild, createGuardian, setConsent } from "@/lib/domain";
import { assertFuelCopy, FUEL_GLANCE_KEYS, sealFuelGlance } from "@/lib/fuel-guards";
import { accruedXp } from "@/lib/fuel";
import { fuelStripText } from "@/lib/home-presentation";
import { INTERFACE_COPY } from "@/lib/interface-copy";
import { catalogItem } from "@/lib/item-catalog";
import { evidenceForSkill, readSkillClientView } from "@/lib/learner-state";
import { MasteryEstimator } from "@/lib/mastery";
import { PARENT_SUMMARY_KEYS, readParentSummary } from "@/lib/parent-summary";

const cleanups: Array<() => void> = [];
const WHEN = "2026-06-15T18:00:00.000Z";
const SAME_DAY = "2026-06-15T20:00:00.000Z";
const NEXT_DAY = "2026-06-16T18:00:00.000Z";
const COUNTER_NAME =
  /^(xp_totals?|xp_balances?|flame_days?|day_counts?|piece_counts?|pieces_filled|fuel_counters?|glance_counters?)$/i;

function tempDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-guards-"));
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

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

function functionBody(file: string, name: string): string {
  const text = source(file);
  const start = text.indexOf(`export function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = text.indexOf("\nexport function ", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

function granted() {
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
  return { db, guardian, child };
}

function honest(
  sessionId: string,
  when: string,
  idempotencyKey: string,
  itemId = "ops-g2-add",
) {
  return {
    idempotencyKey,
    sessionId,
    itemId,
    answer: itemId === "ops-g2-add" ? "42" : "56",
    shownAt: new Date(Date.parse(when) - 2_000).toISOString(),
    submittedAt: when,
  };
}

function xpCount(db: Database.Database, childId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM xp_events WHERE child_id = ?`)
    .get(childId) as { n: number };
  return row.n;
}

function skillRow(db: Database.Database, childId: string, skill: string) {
  return (
    db
      .prepare(
        `SELECT band_label, show_concept_chip, celebration_tier
         FROM learner_skill_state
         WHERE child_id = ? AND skill = ?`,
      )
      .get(childId, skill) ?? null
  );
}

describe("fuel glance seal", () => {
  it("keeps the four fuel fields and refuses a number that would fall", () => {
    const sealed = sealFuelGlance({
      xp: 5,
      dayCount: null,
      pieces: 0,
      goal: 3,
      score: 99,
    } as never);
    expect(Object.keys(sealed)).toEqual([...FUEL_GLANCE_KEYS]);
    expect(sealed).toEqual({ xp: 5, dayCount: null, pieces: 0, goal: 3 });
    expect(() => sealFuelGlance({ xp: -1, dayCount: 1, pieces: 0, goal: 3 })).toThrow(
      /cannot be clawed back/,
    );
    expect(() => sealFuelGlance({ xp: 1.5, dayCount: 1, pieces: 0, goal: 3 })).toThrow(
      /cannot be clawed back/,
    );
    expect(() => sealFuelGlance({ xp: 0, dayCount: 0, pieces: 0, goal: 3 })).toThrow(
      /resting/,
    );
    expect(() => sealFuelGlance({ xp: 0, dayCount: null, pieces: -1, goal: 3 })).toThrow(
      /projection/,
    );
    expect(() => sealFuelGlance({ xp: 0, dayCount: null, pieces: 0, goal: 0 })).toThrow(
      /target/,
    );
    expect(() => assertFuelCopy("You are ahead of the class on the leaderboard.")).toThrow(
      /rank or compare/,
    );
    for (const phrase of ["ranking", "rank", "behind", "versus", "vs"]) {
      expect(() => assertFuelCopy(`A ${phrase} line`)).toThrow(/rank or compare/);
    }
  });
});

describe("fuel numbers are a server-side read", () => {
  it("has no counter table or column, and the readers stay on existing rows", () => {
    const db = tempDb();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(table.name).not.toMatch(COUNTER_NAME);
      const columns = db.pragma(`table_info(${table.name})`) as Array<{ name: string }>;
      for (const column of columns) {
        expect(column.name).not.toMatch(COUNTER_NAME);
      }
    }

    const days = functionBody("../lib/fuel.ts", "loadQualifyingDays");
    expect(days).toContain("kind = 'QualifyingPracticeDay'");
    expect(days).not.toContain("practice_sessions");
    const xp = functionBody("../lib/fuel.ts", "accruedXp");
    expect(xp).toContain("SUM(e.amount)");
    expect(xp).toContain("INNER JOIN qualifying_events");
    expect(xp).not.toMatch(/\bINSERT\b|\bUPDATE\b/);
    const build = source("../lib/build-goal.ts");
    expect(build).toContain("FROM qualifying_events");
    const pieces = functionBody("../lib/build-goal.ts", "projectBuildGoal");
    expect(pieces).toContain("loadBuildPieces");
    expect(pieces).not.toMatch(/\bINSERT\b|\bUPDATE\b/);

    const companion = source("../lib/companion.ts");
    expect(companion).toContain("sealFuelGlance");
    expect(companion).toContain("accruedXp");
    expect(companion).toContain("projectFlameRun");
    expect(companion).toContain("projectBuildGoal");
    expect(companion).not.toContain("INSERT INTO xp_events");

    const childPage = source("../app/child/[id]/page.tsx");
    expect(childPage).not.toContain("use client");
    expect(childPage).toContain("readCompanion");
    expect(source("../components/fuel-strip.tsx")).not.toContain("fetch(");
    const strip = source("../components/fuel-strip.tsx");
    const stripImports = [...strip.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(stripImports).toContain("@/lib/fuel-strip-view");
    for (const specifier of stripImports) {
      expect(specifier).not.toMatch(
        /learner-state|mastery|home-presentation|qualifying-bus|companion|attempts|fuel-guards|better-sqlite3|app-build/,
      );
    }
    expect(source("../lib/fuel-strip-view.ts")).not.toMatch(/\bimport\b/);
    expect(source("../components/child-home.tsx")).toContain("fuelStripText(");
    expect(source("../components/child-home.tsx")).not.toContain("fetch(");
  });

  it("ignores a client attempt body that tries to write the glance", () => {
    const { db, guardian, child } = granted();
    const session = startPracticeSession(db, guardian.id, child.id);
    const parsed = parseSubmitAttempt({
      idempotencyKey: "client-write-01",
      sessionId: session.sessionId,
      itemId: "ops-g2-add",
      answer: "42",
      shownAt: new Date(Date.parse(WHEN) - 2_000).toISOString(),
      submittedAt: WHEN,
      xp: 999,
      dayCount: 40,
      pieces: 9,
      glance: { xp: 999 },
    });
    expect(Object.keys(parsed).sort()).toEqual(
      ["answer", "idempotencyKey", "itemId", "sessionId", "shownAt", "submittedAt"].sort(),
    );
    const before = xpCount(db, child.id);
    const result = submitAttempt(db, guardian.id, child.id, parsed, { now: WHEN });
    expect(result.xpAmount).toBe(XP_AMOUNT.full);
    expect(xpCount(db, child.id)).toBe(before + 1);
    expect(readCompanion(db, child.id, WHEN).glance.xp).toBe(XP_AMOUNT.full);

    const attemptRoute = source("../app/api/children/[id]/attempts/route.ts");
    expect(attemptRoute).toContain("parseSubmitAttempt");
    expect(attemptRoute).not.toMatch(/glance|dayCount|pieces/);
    const queued = source("../lib/offline-queue.ts");
    const queuedType = queued.slice(
      queued.indexOf("export type QueuedAttempt"),
      queued.indexOf("export type BlockedAttempt"),
    );
    expect(queuedType).not.toMatch(/\bxp\b|dayCount|pieces|glance/);
    const practice = source("../components/practice-session.tsx");
    expect(practice).toContain("JSON.stringify(attempt)");
    expect(practice).not.toMatch(/glance|dayCount/);
  });

  it("leaves the day count unchanged when a session never mints QualifyingPracticeDay", () => {
    const { db, guardian, child } = granted();
    const beforeEvents = xpCount(db, child.id);
    expect(readCompanion(db, child.id, WHEN).glance).toEqual({
      xp: 0,
      dayCount: null,
      pieces: 0,
      goal: 3,
    });
    expect(xpCount(db, child.id)).toBe(beforeEvents);

    const session = startPracticeSession(db, guardian.id, child.id);
    const blank = submitAttempt(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "blank-session-01",
        sessionId: session.sessionId,
        itemId: "ops-g2-add",
        answer: "   ",
        shownAt: new Date(Date.parse(WHEN) - 2_000).toISOString(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    expect(blank.eventIds).toEqual([]);
    endPracticeSession(db, guardian.id, child.id, session.sessionId);
    choosePracticeLane(db, guardian.id, child.id, session.sessionId, "recommended");
    startPracticeSession(db, guardian.id, child.id);
    expect(readCompanion(db, child.id, NEXT_DAY).glance).toEqual({
      xp: 0,
      dayCount: null,
      pieces: 0,
      goal: 3,
    });
  });

  it("keeps one qualifying day when a second session on that day adds XP", () => {
    const { db, guardian, child } = granted();
    const firstSession = startPracticeSession(db, guardian.id, child.id);
    submitAttempt(db, guardian.id, child.id, honest(firstSession.sessionId, WHEN, "same-day-first"), {
      now: WHEN,
    });
    endPracticeSession(db, guardian.id, child.id, firstSession.sessionId);
    choosePracticeLane(db, guardian.id, child.id, firstSession.sessionId, "recommended");
    const first = readCompanion(db, child.id, WHEN).glance;
    expect(first.dayCount).toBe(1);
    expect(first.xp).toBe(XP_AMOUNT.full);

    const secondSession = startPracticeSession(db, guardian.id, child.id);
    submitAttempt(
      db,
      guardian.id,
      child.id,
      honest(secondSession.sessionId, SAME_DAY, "same-day-second"),
      { now: SAME_DAY },
    );
    const second = readCompanion(db, child.id, SAME_DAY).glance;
    expect(second.dayCount).toBe(1);
    expect(second.xp).toBeGreaterThan(first.xp);
    expect(second.xp).toBe(accruedXp(db, child.id));
  });
});

describe("XP never decreases and does not rank", () => {
  it("rejects a clawback, a credit with no bus row, and a negative amount", () => {
    const { db, guardian, child } = granted();
    const session = startPracticeSession(db, guardian.id, child.id);
    const result = submitAttempt(
      db,
      guardian.id,
      child.id,
      honest(session.sessionId, WHEN, "append-only-01"),
      { now: WHEN },
    );
    const glance = readCompanion(db, child.id, WHEN).glance;
    expect(glance.xp).toBe(XP_AMOUNT.full);
    expect(() => db.prepare(`UPDATE xp_events SET amount = amount - 1`).run()).toThrow(
      /append-only/,
    );
    expect(accruedXp(db, child.id)).toBe(glance.xp);
    expect(() =>
      db
        .prepare(
          `INSERT INTO xp_events (
             id, attempt_id, child_id, amount, celebration_tier, minted_at, qualifying_event_id
           ) VALUES (?, ?, ?, 1, 'quietXp', ?, NULL)`,
        )
        .run(randomUUID(), result.attemptId, child.id, WHEN),
    ).toThrow(/qualifying event|NOT NULL/i);

    const bareAttempt = randomUUID();
    db.prepare(
      `INSERT INTO attempts (
         id, child_id, session_id, idempotency_key, item_id, answer,
         shown_at, submitted_at, correct, lane, celebration_tier,
         flags_json, beats_json, client_view_json, created_at
       ) VALUES (?, ?, ?, 'negative-xp-attempt', 'ops-g3-mul', '56', ?, ?, 1, 'celebrate', 'full', '[]', '{}', '{}', ?)`,
    ).run(
      bareAttempt,
      child.id,
      session.sessionId,
      new Date(Date.parse(WHEN) - 2_000).toISOString(),
      WHEN,
      WHEN,
    );
    const busId = result.eventIds[0];
    expect(busId).toBeTruthy();
    expect(() =>
      db
        .prepare(
          `INSERT INTO xp_events (
             id, attempt_id, child_id, amount, celebration_tier, minted_at, qualifying_event_id
           ) VALUES (?, ?, ?, -1, 'full', ?, ?)`,
        )
        .run(randomUUID(), bareAttempt, child.id, WHEN, busId),
    ).toThrow(/CHECK|constraint/i);
    expect(readCompanion(db, child.id, WHEN).glance.xp).toBe(glance.xp);

    for (const value of Object.values(INTERFACE_COPY)) {
      expect(() => assertFuelCopy(value)).not.toThrow();
    }
    expect(
      fuelStripText({
        started: true,
        dayCount: glance.dayCount,
        xp: glance.xp,
        pieces: glance.pieces,
        goal: glance.goal,
      }),
    ).toBe(`🔥 ${glance.dayCount}-day flame · ⭐ ${glance.xp} XP · 🧩 ${glance.pieces}/${glance.goal}`);
    expect(source("../components/child-home.tsx")).not.toMatch(
      /leaderboard|ranking|\brank\b|ahead of|behind|versus|\bvs\b/i,
    );
  });
});

describe("fuel state stays out of learner decisions", () => {
  it("can add a bus credit without moving the skill band or the estimator", () => {
    const { db, guardian, child } = granted();
    const session = startPracticeSession(db, guardian.id, child.id);
    submitAttempt(db, guardian.id, child.id, honest(session.sessionId, WHEN, "band-hold-0001"), {
      now: WHEN,
    });
    const skill = "adding two-digit numbers";
    const estimator = new MasteryEstimator();
    const beforeView = readSkillClientView(db, child.id, skill);
    const beforeEvidence = evidenceForSkill(db, child.id, skill);
    const beforeDecision = estimator.decideProgression(beforeEvidence);
    const beforeRow = skillRow(db, child.id, skill);
    const beforeGlance = readCompanion(db, child.id, WHEN).glance;
    expect(beforeView?.bandLabel).toBe("Getting it");
    expect(beforeDecision).toBe("stay");

    const attemptId = randomUUID();
    const eventId = randomUUID();
    const otherSkill = "multiplying within 100";
    db.prepare(
      `INSERT INTO attempts (
         id, child_id, session_id, idempotency_key, item_id, answer,
         shown_at, submitted_at, correct, lane, celebration_tier,
         flags_json, beats_json, client_view_json, created_at
       ) VALUES (?, ?, ?, 'other-skill-xp-01', 'ops-g3-mul', '56', ?, ?, 1, 'celebrate', 'full', '[]', '{}', '{}', ?)`,
    ).run(
      attemptId,
      child.id,
      session.sessionId,
      new Date(Date.parse(WHEN) - 2_000).toISOString(),
      WHEN,
      WHEN,
    );
    db.prepare(
      `INSERT INTO qualifying_events (
         id, child_id, kind, idempotency_key, attempt_id, session_id, skill,
         local_day, qualifies, payload_json, created_at
       ) VALUES (?, ?, 'HonestAttempt', 'other-skill-honest-01', ?, ?, ?, NULL, 1, '{}', ?)`,
    ).run(eventId, child.id, attemptId, session.sessionId, otherSkill, WHEN);
    db.prepare(
      `INSERT INTO xp_events (
         id, attempt_id, child_id, amount, celebration_tier, minted_at, qualifying_event_id
       ) VALUES (?, ?, ?, ?, 'full', ?, ?)`,
    ).run(randomUUID(), attemptId, child.id, XP_AMOUNT.full, WHEN, eventId);

    const after = readCompanion(db, child.id, WHEN).glance;
    expect(after.xp).toBe(beforeGlance.xp + XP_AMOUNT.full);
    expect(after.dayCount).toBe(beforeGlance.dayCount);
    expect(after.pieces).toBe(beforeGlance.pieces);
    expect(after.goal).toBe(beforeGlance.goal);
    expect(readSkillClientView(db, child.id, skill)).toEqual(beforeView);
    expect(skillRow(db, child.id, skill)).toEqual(beforeRow);
    expect(skillRow(db, child.id, otherSkill)).toBeNull();
    expect(evidenceForSkill(db, child.id, skill)).toEqual(beforeEvidence);
    expect(estimator.decideProgression(evidenceForSkill(db, child.id, skill))).toBe(
      beforeDecision,
    );
    expect(catalogItem("ops-g3-mul")?.skill).toBe(otherSkill);

    const isolated = [
      "../lib/mastery.ts",
      "../lib/learner-state.ts",
      "../lib/qualifying-bus.ts",
      "../lib/parent-summary.ts",
      "../components/parent-one-breath.tsx",
      "../components/practice-session.tsx",
      "../components/practice-feedback.tsx",
      "../components/mint-toast.tsx",
    ];
    for (const file of isolated) {
      expect(source(file), file).not.toMatch(
        /accruedXp|projectFlameRun|fuelStripText|CompanionGlance|sealFuelGlance/,
      );
    }
    const view: ClientView = estimator.toClientView({
      correct: true,
      lane: "celebrate",
      celebrationTier: "full",
    });
    expect(Object.keys(view).sort()).toEqual(
      ["bandLabel", "celebrationTier", "showConceptChip"].sort(),
    );
  });
});

describe("practice toast and parent one-breath stay XP-free of a running total", () => {
  it("keeps the quiet toast and leaves XP off the parent card", () => {
    const item = catalogItem("ops-g2-add");
    if (!item) throw new Error("missing item");
    const result: AttemptResult = {
      attemptId: "attempt-1",
      idempotencyKey: "toast-key-01",
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
      fuel: { credit: XP_AMOUNT.full, heatEventId: "heat-1", pieceEventIds: ["piece-a"] },
      clientView: {
        bandLabel: "Getting it",
        showConceptChip: true,
        celebrationTier: "full",
      },
      nextItem: item,
    };
    const feedback = renderToStaticMarkup(
      createElement(PracticeFeedback, { feedback: result, item }),
    );
    const toast = renderToStaticMarkup(
      createElement(MintToast, {
        tier: "full",
        credit: XP_AMOUNT.full,
        eventCount: 2,
        pieceEventIds: ["piece-a"],
        replayed: false,
      }),
    );
    expect(feedback).toContain("A sprout for that try.");
    expect(feedback).not.toMatch(/\d+\s*XP/);
    expect(toast).toContain("A sprout for that try.");
    expect(toast).not.toMatch(/\d+\s*XP/);
    expect(source("../components/practice-session.tsx")).not.toMatch(/\d+\s*XP/);
    expect(source("../components/mint-toast.tsx")).not.toMatch(/\d+\s*XP/);

    const { db, guardian, child } = granted();
    const session = startPracticeSession(db, guardian.id, child.id);
    submitAttempt(db, guardian.id, child.id, honest(session.sessionId, WHEN, "parent-breath-01"), {
      now: WHEN,
    });
    const summary = readParentSummary(db, guardian.id, child.id, WHEN);
    expect(Object.keys(summary).sort()).toEqual([...PARENT_SUMMARY_KEYS].sort());
    expect(summary.practiced).toBe(true);
    const card = renderToStaticMarkup(createElement(ParentOneBreathCard, { summary }));
    expect(card).toContain('data-testid="parent-one-breath"');
    expect(card).not.toMatch(/\bXP\b/);
    expect(JSON.stringify(summary)).not.toMatch(/\bXP\b/);
    expect(source("../components/parent-one-breath.tsx")).not.toMatch(/\bXP\b|glance\.xp|dayCount/);
  });
});
