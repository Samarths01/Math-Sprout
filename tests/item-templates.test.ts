import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { parseSubmitAttempt, startPracticeSession, submitAnswer, submitAttempt } from "@/lib/attempts";
import { openDatabase } from "@/lib/db";
import { DomainError, createChild, createGuardian, setConsent } from "@/lib/domain";
import { SKILLS, TEMPLATE_VERSIONS, generatedTemplates } from "@/lib/templates/catalog";
import { ambiguousBugs, drawAccepted, drawOnce, seeded, validateTemplate } from "@/lib/templates/engine";
import { cueText } from "@/lib/templates/cues";
import { exactRepeatRate, formatRejectRates, stepsPracticed } from "@/lib/templates/instruments";
import {
  ISSUE_BATCH_CAP,
  PROGRESSION_DIFFICULTY_STEP,
  focusForStoredAnswer,
  gradeStoredAnswer,
  issueForProgression,
  issueItemBatch,
  pickOldestExposure,
  readItemInstance,
  variantsForAssignedStep,
  type ItemInstance,
} from "@/lib/templates/issue";
import { answersMatch } from "@/lib/templates/rational";
import { ISSUANCE_TEMPLATE_COLUMNS, issuanceTemplateSelect } from "@/lib/templates/store";
import type { TemplateVersion } from "@/lib/templates/types";
import { evidenceForSkill } from "@/lib/learner-state";
import { createAttemptQueue, memoryQueueStore } from "@/lib/offline-queue";
import { provisionalVerdict } from "@/lib/provisional-verdict";
import { POLICY_VERSION } from "@/lib/policy";
import { isFormatRejected, UNPARSEABLE_BEHAVIOR, UNPARSEABLE_HINT } from "@/lib/unparseable";

const cleanups: Array<() => void> = [];
const WHEN = "2026-06-15T18:00:00.000Z";

function tempDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-items-"));
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

function granted(db: Database.Database, email = "parent@example.com") {
  const guardian = createGuardian(db, {
    email,
    password: "correct-horse",
    timezone: "America/Los_Angeles",
  });
  const child = createChild(db, guardian.id, { displayName: "Ava" });
  setConsent(db, guardian.id, child.id, "grant");
  const session = startPracticeSession(db, guardian.id, child.id);
  return { guardian, child, session };
}

function shown(): string {
  return new Date(Date.parse(WHEN) - 2_000).toISOString();
}

function xpCount(db: Database.Database, attemptId?: string): number {
  const row = attemptId
    ? (db.prepare(`SELECT COUNT(*) AS count FROM xp_events WHERE attempt_id = ?`).get(attemptId) as {
        count: number;
      })
    : (db.prepare(`SELECT COUNT(*) AS count FROM xp_events`).get() as { count: number });
  return row.count;
}

function qeCount(db: Database.Database, attemptId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM qualifying_events WHERE attempt_id = ?`).get(attemptId) as {
      count: number;
    }
  ).count;
}

function itemIndex(db: Database.Database, sessionId: string): number {
  return (
    db.prepare(`SELECT item_index AS itemIndex FROM practice_sessions WHERE id = ?`).get(sessionId) as {
      itemIndex: number;
    }
  ).itemIndex;
}

function streakState(db: Database.Database, childId: string): string | null {
  const row = db
    .prepare(`SELECT streak_state FROM learner_progress WHERE child_id = ?`)
    .get(childId) as { streak_state: string } | undefined;
  return row?.streak_state ?? null;
}

function attemptCount(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM attempts`).get() as { count: number }).count;
}

function qualifyingDays(db: Database.Database, childId: string): number {
  return (
    db.prepare(
      `SELECT COUNT(*) AS count FROM qualifying_events
       WHERE child_id = ? AND kind = 'QualifyingPracticeDay'`,
    ).get(childId) as { count: number }
  ).count;
}

function instanceCount(db: Database.Database, childId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM item_instances WHERE child_id = ?`).get(childId) as {
      count: number;
    }
  ).count;
}

function ogcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function ofrac(n: number, d: number): string {
  const g = ogcd(n, d);
  const nn = n / g;
  const dd = d / g;
  return dd === 1 ? String(nn) : `${nn}/${dd}`;
}

/** Independent of the interpreter. Keep this switch in the test. */
function oracle(op: string, work: Record<string, number>): string | null {
  const a = work.a ?? 0;
  const b = work.b ?? 0;
  switch (op) {
    case "add":
      return String(a + b);
    case "add_gap":
      return String((work.sum ?? 0) - a);
    case "add_gap_left":
      return String((work.sum ?? 0) - b);
    case "sub":
      return a > b ? String(a - b) : null;
    case "sub_gap":
      return a > (work.diff ?? 0) ? String(a - (work.diff ?? 0)) : null;
    case "mul":
      return String(a * b);
    case "blank_b":
      return b > 0 ? String(b) : null;
    case "blank_a":
      return a > 0 ? String(a) : null;
    case "div":
      return b !== 0 && a % b === 0 ? String(a / b) : null;
    case "quot":
      return (work.q ?? 0) > 0 ? String(work.q) : null;
    case "divisor":
      return b > 0 ? String(b) : null;
    case "dividend":
      return a > 0 ? String(a) : null;
    case "larger_unit": {
      const d1 = work.d1 ?? 0;
      const d2 = work.d2 ?? 0;
      if (d1 <= 1 || d2 <= 1 || d1 === d2) return null;
      return `1/${Math.min(d1, d2)}`;
    }
    case "smaller_unit": {
      const d1 = work.d1 ?? 0;
      const d2 = work.d2 ?? 0;
      if (d1 <= 1 || d2 <= 1 || d1 === d2) return null;
      return `1/${Math.max(d1, d2)}`;
    }
    case "symbol_gt": {
      const d1 = work.d1 ?? 0;
      const d2 = work.d2 ?? 0;
      if (d1 <= 1 || d2 <= 1 || d1 === d2) return null;
      return d1 < d2 ? ">" : "<";
    }
    case "scale_num":
      return String((work.n ?? 0) * (work.k ?? 0));
    case "scale_exact": {
      const n = (work.n ?? 0) * (work.k ?? 0);
      const d = (work.d ?? 0) * (work.k ?? 0);
      return d > 0 ? `${n}/${d}` : null;
    }
    case "lowest":
      return (work.d ?? 0) > 0 && ogcd(work.n ?? 0, work.d ?? 0) > 1
        ? ofrac(work.n ?? 0, work.d ?? 0)
        : null;
    case "to_improper": {
      const whole = work.whole ?? 0;
      const n = work.n ?? 0;
      const d = work.d ?? 0;
      if (whole < 1 || d <= 1 || n <= 0 || n >= d) return null;
      return `${whole * d + n}/${d}`;
    }
    case "to_mixed": {
      const n = work.n ?? 0;
      const d = work.d ?? 0;
      if (d <= 1 || n <= d || n % d === 0) return null;
      return `${Math.floor(n / d)} ${n % d}/${d}`;
    }
    case "frac_add_like": {
      const d = work.d ?? 0;
      const n1 = work.n1 ?? 0;
      const n2 = work.n2 ?? 0;
      if (d <= 0 || n1 <= 0 || n2 <= 0) return null;
      return ofrac(n1 + n2, d);
    }
    case "frac_add_gap": {
      const n2 = (work.sumN ?? 0) - (work.n1 ?? 0);
      return n2 > 0 ? String(n2) : null;
    }
    case "frac_add_unlike": {
      const d1 = work.d1 ?? 0;
      const d2 = work.d2 ?? 0;
      if (d1 <= 0 || d2 <= 0) return null;
      return ofrac((work.n1 ?? 0) * d2 + (work.n2 ?? 0) * d1, d1 * d2);
    }
    case "frac_sub_like": {
      const d = work.d ?? 0;
      const num = (work.n1 ?? 0) - (work.n2 ?? 0);
      if (d <= 0 || num <= 0) return null;
      return ofrac(num, d);
    }
    default:
      return null;
  }
}

function spanOf(template: TemplateVersion, work: Record<string, number>, drawn: Record<string, number>): number {
  if (template.spec.family === "div" && work.a !== undefined) return work.a;
  const values = Object.values(drawn);
  return values.length > 0 ? Math.max(...values) : 0;
}

describe("item templates and issuance", () => {
  it("does not let legacy v0 templates satisfy the three-template bar", () => {
    for (const skill of Object.values(SKILLS)) {
      const rows = TEMPLATE_VERSIONS.filter((template) => template.skillId === skill);
      const legacy = rows.filter((template) => template.version === 0 || template.spec.legacy);
      const generated = generatedTemplates(skill);
      expect(legacy.length).toBe(1);
      expect(generated.length).toBeGreaterThanOrEqual(3);
      expect(generated.every((template) => template.version >= 1 && !template.spec.legacy)).toBe(true);
      expect(legacy.length).toBeLessThan(3);
      expect(rows.length - legacy.length).toBe(generated.length);
    }
    expect(generatedTemplates(SKILLS.equiv).map((template) => template.templateId).sort()).toEqual(
      ["frac-equiv-improper", "frac-equiv-lowest", "frac-equiv-mixed", "frac-equiv-scale"].sort(),
    );
  });

  it("keeps computed_step equal to assigned_step for every seed template", () => {
    for (const template of TEMPLATE_VERSIONS) {
      for (const variant of template.spec.steps) {
        expect(variant.computedStep).toBe(variant.assignedStep);
      }
      const report = validateTemplate(template, seeded(template.templateId.length * 17 + template.version + 3));
      expect(report.rejected, `${template.templateId} ${report.reasons.join("; ")}`).toBe(false);
      expect(report.flags, template.templateId).toEqual([]);
      expect(template.provenance).toBe("seed");
    }
  });

  it("rejects a disallowed op and flags a step mismatch without rejecting it", () => {
    const base = TEMPLATE_VERSIONS.find((template) => template.templateId === "add-2d-inline");
    if (!base) throw new Error("missing template");
    const disallowed: TemplateVersion = {
      ...base,
      templateId: "bad-op",
      spec: { ...base.spec, answerOp: "power" },
    };
    const rejected = validateTemplate(disallowed, seeded(1));
    expect(rejected.rejected).toBe(true);
    expect(rejected.reasons.some((reason) => reason.includes("disallowed"))).toBe(true);

    const overlap: TemplateVersion = {
      ...base,
      templateId: "flagged-step",
      spec: {
        ...base.spec,
        steps: [
          {
            ...base.spec.steps[0]!,
            assignedStep: 1,
            computedStep: 1,
            features: { ...base.spec.steps[0]!.features, digits: [1, 4], span: [1, 400], regroups: [0, 4] },
          },
          {
            ...base.spec.steps[0]!,
            assignedStep: 2,
            computedStep: 2,
            features: { ...base.spec.steps[0]!.features, digits: [1, 4], span: [1, 400], regroups: [0, 4] },
          },
        ],
      },
    };
    const flagged = validateTemplate(overlap, seeded(4));
    expect(flagged.rejected).toBe(false);
    expect(flagged.flags.length).toBeGreaterThan(0);
  });

  it("agrees with an independent oracle and holds each step's features", () => {
    for (const template of TEMPLATE_VERSIONS) {
      for (const variant of template.spec.steps) {
        for (let seed = 1; seed <= 6; seed += 1) {
          const draw = drawAccepted(
            template,
            variant.assignedStep,
            seeded(seed * 97 + variant.assignedStep * 13 + template.templateId.length),
            80,
          );
          expect(draw, `${template.templateId} step ${variant.assignedStep}`).not.toBeNull();
          if (!draw) continue;
          expect(oracle(template.spec.answerOp, draw.work)).toBe(draw.canonicalAnswer);
          const span = spanOf(template, draw.work, draw.operands);
          expect(span).toBeGreaterThanOrEqual(variant.features.span[0]);
          expect(span).toBeLessThanOrEqual(variant.features.span[1]);
          expect(draw.features.blank).toBe(variant.features.blank);
          expect(draw.ambiguous).toBe(false);
        }
      }
    }
  });

  it("rejects ambiguous bug draws across seeds", () => {
    expect(
      ambiguousBugs("exact", "12", [
        { id: "a", cueKey: "add.carry", wrong: "12" },
        { id: "b", cueKey: "add.place", wrong: "10" },
      ]),
    ).toBe(true);
    expect(
      ambiguousBugs("exact", "12", [
        { id: "a", cueKey: "add.carry", wrong: "9" },
        { id: "b", cueKey: "add.place", wrong: "9" },
      ]),
    ).toBe(true);
    for (const template of TEMPLATE_VERSIONS) {
      for (const variant of template.spec.steps) {
        for (let seed = 1; seed <= 8; seed += 1) {
          const rng = seeded(seed * 41 + variant.assignedStep);
          for (let attempt = 0; attempt < 10; attempt += 1) {
            const raw = drawOnce(template, variant.assignedStep, rng);
            if (!raw) continue;
            if (raw.ambiguous) {
              expect(ambiguousBugs(template.spec.compare, raw.canonicalAnswer, raw.bugs)).toBe(true);
            }
          }
          const accepted = drawAccepted(template, variant.assignedStep, seeded(seed + 9), 40);
          expect(accepted, template.templateId).not.toBeNull();
          expect(accepted?.ambiguous).toBe(false);
        }
      }
    }
  });

  it("uses a real cue for a matching bug and omits oneFocus when the cue is not real", () => {
    const column = TEMPLATE_VERSIONS.find((template) => template.templateId === "add-2d-column");
    const inline = TEMPLATE_VERSIONS.find((template) => template.templateId === "add-2d-inline");
    if (!column || !inline) throw new Error("missing add templates");
    const missed: ItemInstance = {
      itemInstanceId: "inst-focus",
      childId: "child",
      sessionId: "session",
      templateId: column.templateId,
      templateVersion: column.version,
      difficultyStep: 1,
      operands: {},
      operandKey: "",
      canonicalAnswer: "40",
      answerLine: "22 + 18 = 40",
      prompt: "22 + 18",
      presentation: {
        layout: "column",
        blank: "result",
        leading: "",
        trailing: "",
        column: [],
        stepWord: "Warm-up",
      },
      evidenceEligible: true,
      repeatForced: false,
      issueIdempotencyKey: "issue-key",
      issuedAt: WHEN,
      consumedAt: null,
      consumedByAttemptKey: null,
      requireForm: null,
      compareMode: "exact",
      bugHits: [],
      defaultFocus: column.defaultFocus ?? null,
      whyItWorks: null,
    };
    expect(cueText(column.defaultFocus)).toBe("");
    expect(focusForStoredAnswer(missed, "1").oneFocus).toBe("");
    const carry = focusForStoredAnswer(
      {
        ...missed,
        templateId: inline.templateId,
        defaultFocus: inline.defaultFocus ?? null,
        bugHits: [{ id: "forget-carry", cueKey: "add.carry", wrong: "30" }],
      },
      "30",
    );
    expect(carry.oneFocus).toBe(cueText("add.carry"));
    expect(carry.oneFocus.length).toBeGreaterThan(0);
  });

  it("accepts equivalent fractions except where require_form names one writing", () => {
    expect(answersMatch("1/2", "2/4", "rational", null)).toBe("correct");
    expect(answersMatch("3/2", "1 1/2", "rational", null)).toBe("correct");
    expect(answersMatch("3/2", "6/4", "rational", null)).toBe("correct");
    expect(answersMatch("1/2", "2/4", "rational", "lowest_terms")).toBe("incorrect");
    expect(answersMatch("1/2", "1/2", "rational", "lowest_terms")).toBe("correct");
    expect(answersMatch("3/2", "1 1/2", "rational", "improper")).toBe("incorrect");
    expect(answersMatch("3/2", "3/2", "rational", "improper")).toBe("correct");
    expect(answersMatch("3/2", "1 1/2", "rational", "mixed")).toBe("correct");
    expect(answersMatch("3/2", "3/2", "rational", "mixed")).toBe("incorrect");
    expect(answersMatch("2/4", "1/2", "exact", null)).toBe("incorrect");
    expect(answersMatch("42", "banana", "exact", null)).toBe("unparseable");
    const forms = TEMPLATE_VERSIONS.filter((template) => template.requireForm);
    expect(forms.map((template) => `${template.templateId}:${template.requireForm}`).sort()).toEqual([
      "frac-equiv-improper:improper",
      "frac-equiv-lowest:lowest_terms",
      "frac-equiv-mixed:mixed",
    ]);
  });

  it("leaves parent prior null and does not let issuance read it", () => {
    for (const template of TEMPLATE_VERSIONS) {
      expect(template.parentPriorGrade).toBeNull();
      expect(template.parentPriorDifficulty).toBeNull();
    }
    expect(ISSUANCE_TEMPLATE_COLUMNS.join(",")).not.toMatch(/parent_prior/);
    expect(issuanceTemplateSelect()).not.toMatch(/parent_prior/);
    const sample = TEMPLATE_VERSIONS[0];
    if (!sample) throw new Error("missing template");
    expect(variantsForAssignedStep(sample, PROGRESSION_DIFFICULTY_STEP).every((variant) => variant.assignedStep === 1)).toBe(
      true,
    );
    const db = tempDb();
    const empty = db
      .prepare(
        `SELECT COUNT(*) AS count FROM item_template_versions
         WHERE parent_prior_grade IS NOT NULL OR parent_prior_difficulty IS NOT NULL`,
      )
      .get() as { count: number };
    expect(empty.count).toBe(0);
    db.prepare(
      `UPDATE item_template_versions
       SET parent_prior_grade = 4, parent_prior_difficulty = 'hard'`,
    ).run();
    const { child, session } = granted(db);
    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.add,
      idempotencyKey: "parent-prior-01",
      now: WHEN,
    });
    expect(issued.difficultyStep).toBe(1);
    expect(issued.difficultyStep).toBe(PROGRESSION_DIFFICULTY_STEP);
    expect(issued.presentation.stepWord).toBe("Warm-up");
  });

  it("returns the same instance when issuance is retried", () => {
    const db = tempDb();
    const { child, session } = granted(db);
    const before = instanceCount(db, child.id);
    const first = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.sub,
      idempotencyKey: "retry-slot-01",
      now: WHEN,
    });
    const second = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.sub,
      idempotencyKey: "retry-slot-01",
      now: WHEN,
    });
    expect(second.itemInstanceId).toBe(first.itemInstanceId);
    expect(instanceCount(db, child.id)).toBe(before + 1);
  });

  it("avoids a 7-day exact repeat and a back-to-back template", () => {
    const db = tempDb();
    const { child, session } = granted(db);
    const seen = new Set<string>();
    let previous = "";
    for (let index = 0; index < 8; index += 1) {
      const issued = issueForProgression(db, {
        childId: child.id,
        sessionId: session.sessionId,
        skillId: SKILLS.add,
        idempotencyKey: `fresh-slot-${index}1`,
        now: WHEN,
      });
      const key = `${issued.templateId}:${issued.operandKey}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(issued.repeatForced).toBe(false);
      if (previous) expect(issued.templateId).not.toBe(previous);
      previous = issued.templateId;
    }
    const rate = exactRepeatRate(db, child.id, WHEN);
    expect(rate.forced).toBe(0);
    expect(rate.rate).toBe(0);
    const steps = stepsPracticed(db, child.id);
    expect(steps.some((row) => row.skill === SKILLS.add && row.step === 1 && row.count >= 8)).toBe(true);
  });

  it("forces the oldest exposure when the pool is exhausted", () => {
    expect(
      pickOldestExposure([
        { templateId: "b", operandKey: "a=1", lastAt: "2026-06-01T00:00:00.000Z" },
        { templateId: "a", operandKey: "a=2", lastAt: "2026-06-01T00:00:00.000Z" },
        { templateId: "c", operandKey: "a=3", lastAt: "2026-06-02T00:00:00.000Z" },
      ]),
    ).toEqual({ templateId: "a", operandKey: "a=2", lastAt: "2026-06-01T00:00:00.000Z" });
    const db = tempDb();
    db.prepare(
      `UPDATE item_template_versions SET active = 0
       WHERE skill_id = ? AND template_id != 'add-2d-v0'`,
    ).run(SKILLS.add);
    const { child, session } = granted(db);
    const first = readItemInstance(db, session.item.itemInstanceId ?? "");
    if (!first) throw new Error("session did not issue");
    const second = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.add,
      idempotencyKey: "exhaust-slot-02",
      now: WHEN,
    });
    expect(first.templateId).toBe("add-2d-v0");
    expect(first.repeatForced).toBe(false);
    expect(second.templateId).toBe("add-2d-v0");
    expect(second.operandKey).toBe(first.operandKey);
    expect(second.canonicalAnswer).toBe(first.canonicalAnswer);
    expect(second.repeatForced).toBe(true);
    const rate = exactRepeatRate(db, child.id, WHEN);
    expect(rate.forced).toBeGreaterThan(0);
    expect(rate.rate).toBeGreaterThan(0);
  });

  it("keeps the instance copy of evidence_eligible after the template changes", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db);
    const issued = readItemInstance(db, session.item.itemInstanceId ?? "");
    if (!issued) throw new Error("session did not issue");
    expect(issued.evidenceEligible).toBe(true);
    const version = issued.templateVersion;
    db.prepare(
      `UPDATE item_template_versions SET evidence_eligible = 0, active = 0
       WHERE template_id = ? AND template_version = ?`,
    ).run(issued.templateId, version);
    db.prepare(
      `INSERT INTO item_template_versions (
         template_id, template_version, skill_id, prompt_shape, spec_json, bug_rules_json,
         default_focus, why_it_works, require_form, provenance, evidence_eligible,
         parent_prior_grade, parent_prior_difficulty, active, promoted, content_hash
       )
       SELECT template_id, template_version + 1, skill_id, prompt_shape, spec_json, bug_rules_json,
              default_focus, why_it_works, require_form, provenance, 0,
              parent_prior_grade, parent_prior_difficulty, 1, promoted, content_hash
       FROM item_template_versions
       WHERE template_id = ? AND template_version = ?`,
    ).run(issued.templateId, version);
    const before = evidenceForSkill(db, child.id, session.item.skill);
    const result = submitAttempt(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "frozen-copy-01",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: issued.canonicalAnswer,
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    const stored = readItemInstance(db, issued.itemInstanceId);
    expect(stored?.templateVersion).toBe(version);
    expect(stored?.evidenceEligible).toBe(true);
    const attempt = db
      .prepare(`SELECT estimator_evidence, template_id, difficulty_step FROM attempts WHERE id = ?`)
      .get(result.attemptId) as {
      estimator_evidence: number;
      template_id: string;
      difficulty_step: number;
    };
    expect(attempt.estimator_evidence).toBe(1);
    expect(attempt.template_id).toBe(issued.templateId);
    expect(attempt.difficulty_step).toBe(1);
    expect(evidenceForSkill(db, child.id, session.item.skill).length).toBe(before.length + 1);
    expect(result.correct).toBe(true);
  });

  it("scores only the stored instance and rejects forged operands, foreign instances, and consumed replays", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db);
    const issued = readItemInstance(db, session.item.itemInstanceId ?? "");
    if (!issued) throw new Error("session did not issue");
    const beforeAttempts = (
      db.prepare(`SELECT COUNT(*) AS count FROM attempts`).get() as { count: number }
    ).count;
    expect(() =>
      parseSubmitAttempt({
        idempotencyKey: "forged-key-0001",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: issued.canonicalAnswer,
        shownAt: shown(),
        submittedAt: WHEN,
        operands: { a: 1 },
        canonicalAnswer: "0",
      }),
    ).toThrow(DomainError);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM attempts`).get() as { count: number }).count).toBe(
      beforeAttempts,
    );
    expect(xpCount(db)).toBe(0);

    const other = createChild(db, guardian.id, { displayName: "Bea" });
    setConsent(db, guardian.id, other.id, "grant");
    const otherSession = startPracticeSession(db, guardian.id, other.id);
    expect(() =>
      submitAttempt(db, guardian.id, other.id, {
        idempotencyKey: "foreign-key-01",
        sessionId: otherSession.sessionId,
        itemId: otherSession.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: issued.canonicalAnswer,
        shownAt: shown(),
        submittedAt: WHEN,
      }),
    ).toThrow(DomainError);
    expect(xpCount(db)).toBe(0);

    const scored = submitAttempt(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "stored-score-01",
        sessionId: session.sessionId,
        itemId: "ops-g3-mul",
        itemInstanceId: issued.itemInstanceId,
        answer: issued.canonicalAnswer,
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    expect(scored.correct).toBe(true);
    expect(scored.lockIn).toBe(issued.answerLine);
    expect(scored.lockIn).not.toContain("canonical");
    const minted = xpCount(db, scored.attemptId);
    expect(() =>
      submitAttempt(db, guardian.id, child.id, {
        idempotencyKey: "stored-score-02",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: issued.canonicalAnswer,
        shownAt: shown(),
        submittedAt: WHEN,
      }),
    ).toThrow(DomainError);
    expect(xpCount(db, scored.attemptId)).toBe(minted);
    expect(
      (db.prepare(`SELECT COUNT(*) AS count FROM attempts WHERE idempotency_key = 'stored-score-02'`).get() as {
        count: number;
      }).count,
    ).toBe(0);
  });

  it("replays the stored canonical answer after the template changes", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db);
    const issued = readItemInstance(db, session.item.itemInstanceId ?? "");
    if (!issued) throw new Error("session did not issue");
    const first = submitAttempt(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "replay-canon-01",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: issued.canonicalAnswer,
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    db.prepare(
      `UPDATE item_template_versions
       SET spec_json = json_set(spec_json, '$.answerOp', 'add'), evidence_eligible = 0
       WHERE template_id = ? AND template_version = ?`,
    ).run(issued.templateId, issued.templateVersion);
    const replay = submitAttempt(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "replay-canon-01",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: "0",
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.clientView).toEqual(first.clientView);
    expect(replay.lockIn).toBe(first.lockIn);
    expect(replay.correct).toBe(first.correct);
    expect(POLICY_VERSION).toBe("rules-v0");
  });

  it("rejects an unreadable answer with no attempt, no mint, and no fuel line", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db);
    const skill = session.item.skill;
    const blank = submitAttempt(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "blank-path-0001",
        sessionId: session.sessionId,
        itemId: session.item.id,
        answer: "   ",
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    expect(blank.xpAmount).toBe(0);
    expect(blank.lane).toBe("review");
    expect(blank.flags).toContain("empty_answer");
    expect(blank.lockIn).toBe("A blank answer stays quiet.");
    const blankEvidence = evidenceForSkill(db, child.id, skill);
    expect(blankEvidence.some((row) => row.correct === false && row.lane === "review")).toBe(true);
    expect(blankEvidence.some((row) => row.correct === false && row.lane === "celebrate")).toBe(false);

    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: skill,
      idempotencyKey: "format-slot-01",
      now: WHEN,
    });
    const before = evidenceForSkill(db, child.id, skill);
    const beforeXp = xpCount(db);
    const beforeStreak = streakState(db, child.id);
    const beforeIndex = itemIndex(db, session.sessionId);
    const beforeAttempts = attemptCount(db);
    const beforeDays = qualifyingDays(db, child.id);
    const raw = "banana";
    const rejected = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "format-key-0001",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: raw,
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    expect(UNPARSEABLE_BEHAVIOR).toBe("retry");
    expect(isFormatRejected(rejected)).toBe(true);
    if (!isFormatRejected(rejected)) throw new Error("expected format_rejected");
    expect(rejected).toEqual({
      type: "format_rejected",
      behavior: "retry",
      hint: UNPARSEABLE_HINT,
    });
    expect(rejected.hint).toBe("Type a number like 3 or 1/2.");
    expect(rejected.hint).not.toContain(issued.canonicalAnswer);
    expect(rejected.hint).not.toContain(raw);
    expect(rejected).not.toHaveProperty("fuel");
    expect(rejected).not.toHaveProperty("correct");
    expect(rejected).not.toHaveProperty("attemptId");
    expect(rejected).not.toHaveProperty("xpAmount");
    expect(attemptCount(db)).toBe(beforeAttempts);
    expect(db.prepare(`SELECT id FROM attempts WHERE idempotency_key = ?`).get("format-key-0001")).toBeUndefined();
    expect(xpCount(db)).toBe(beforeXp);
    expect(qualifyingDays(db, child.id)).toBe(beforeDays);
    expect(evidenceForSkill(db, child.id, skill)).toEqual(before);
    expect(streakState(db, child.id)).toBe(beforeStreak);
    expect(itemIndex(db, session.sessionId)).toBe(beforeIndex);
    const held = readItemInstance(db, issued.itemInstanceId);
    expect(held?.consumedAt).toBeNull();
    expect(held?.issuedAt).toBe(WHEN);
    expect(exactRepeatRate(db, child.id, WHEN).issued).toBeGreaterThan(0);
    const rejectColumns = (db.pragma("table_info(answer_format_rejects)") as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(rejectColumns).not.toContain("answer");
    const rejects = db.prepare(`SELECT * FROM answer_format_rejects`).all() as Array<Record<string, unknown>>;
    expect(rejects).toHaveLength(1);
    expect(JSON.stringify(rejects)).not.toContain(raw);
    const shape = db
      .prepare(
        `SELECT prompt_shape AS promptType, provenance FROM item_template_versions
         WHERE template_id = ? AND template_version = ?`,
      )
      .get(issued.templateId, issued.templateVersion) as { promptType: string; provenance: string };
    expect(formatRejectRates(db, child.id)).toEqual([
      {
        templateVersion: issued.templateVersion,
        provenance: "seed",
        promptType: shape.promptType,
        rejects: 1,
        attempts: 0,
        rate: 1,
      },
    ]);
    expect(shape.provenance).toBe("seed");

    const later = "2026-06-15T18:00:20.000Z";
    const scored = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "format-key-0001",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: issued.canonicalAnswer,
        shownAt: new Date(Date.parse(later) - 2_000).toISOString(),
        submittedAt: later,
      },
      { now: later },
    );
    if (isFormatRejected(scored)) throw new Error("a readable answer was rejected");
    expect(scored.correct).toBe(true);
    expect(scored.idempotencyKey).toBe("format-key-0001");
    expect(scored.fuel).toBeDefined();
    expect(scored.xpAmount).toBeGreaterThan(0);
    expect(qeCount(db, scored.attemptId)).toBeGreaterThan(0);
    expect(readItemInstance(db, issued.itemInstanceId)?.consumedByAttemptKey).toBe("format-key-0001");
    expect(formatRejectRates(db, child.id)).toEqual([
      {
        templateVersion: issued.templateVersion,
        provenance: "seed",
        promptType: shape.promptType,
        rejects: 1,
        attempts: 1,
        rate: 0.5,
      },
    ]);
  });

  it("locks an unreadable answer without writing an attempt", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db);
    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: session.item.skill,
      idempotencyKey: "format-lock-slot",
      now: WHEN,
    });
    const beforeAttempts = attemptCount(db);
    const beforeXp = xpCount(db);
    const raw = "banana";
    const rejected = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "format-lock-0001",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: raw,
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN, unparseableBehavior: "lock" },
    );
    if (!isFormatRejected(rejected)) throw new Error("expected format_rejected");
    expect(rejected.behavior).toBe("lock");
    expect(rejected.hint).toBe("That answer stays quiet.");
    expect(rejected).not.toHaveProperty("fuel");
    expect(attemptCount(db)).toBe(beforeAttempts);
    expect(xpCount(db)).toBe(beforeXp);
    expect(db.prepare(`SELECT id FROM attempts WHERE idempotency_key = ?`).get("format-lock-0001")).toBeUndefined();
    expect(JSON.stringify(db.prepare(`SELECT * FROM answer_format_rejects`).all())).not.toContain(raw);
    expect(readItemInstance(db, issued.itemInstanceId)?.consumedAt).toBeTruthy();
    expect(() =>
      submitAnswer(db, guardian.id, child.id, {
        idempotencyKey: "format-lock-0002",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: issued.canonicalAnswer,
        shownAt: shown(),
        submittedAt: WHEN,
      }),
    ).toThrow(DomainError);
    expect(attemptCount(db)).toBe(beforeAttempts);
  });

  it("keeps the answer parser free of server imports", () => {
    const root = new URL("../", import.meta.url);
    const parser = readFileSync(new URL("lib/answer-parser.ts", root), "utf8");
    expect(parser).not.toMatch(/\bimport\b/);
    expect(parser).not.toMatch(/better-sqlite3|@\/lib\/db|@\/lib\/attempts|server-only/);
    expect(parser).toContain("export function parseAnswer");
    const client = readFileSync(new URL("components/practice-session.tsx", root), "utf8");
    const offline = readFileSync(new URL("lib/offline-queue.ts", root), "utf8");
    expect(client).toContain('from "@/lib/answer-parser"');
    expect(offline).toContain('from "@/lib/answer-parser"');
    expect(readFileSync(new URL("lib/templates/rational.ts", root), "utf8")).not.toMatch(
      /function parseAnswer\b/,
    );
    const skip = new Set(["answer-parser.ts"]);
    function walk(dir: URL): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        const next = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
        if (entry.isDirectory()) {
          walk(next);
          continue;
        }
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
        if (skip.has(entry.name)) continue;
        expect(readFileSync(next, "utf8"), entry.name).not.toMatch(/function parseAnswer\b/);
      }
    }
    walk(new URL("lib/", root));
    walk(new URL("components/", root));
  });

  it("does not queue an unreadable answer as an offline attempt", () => {
    const queue = createAttemptQueue(memoryQueueStore());
    const base = {
      idempotencyKey: "offline-format-01",
      childId: "child-1",
      sessionId: "session-1",
      itemId: "ops-g2-add",
      shownAt: shown(),
      submittedAt: WHEN,
    };
    const rejected = queue.enqueue({ ...base, answer: "banana" });
    expect(rejected.pending).toEqual([]);
    expect(rejected.formatRejected).toBe(true);
    const blank = queue.enqueue({ ...base, idempotencyKey: "offline-blank-01", answer: "   " });
    expect(blank.pending).toHaveLength(1);
    expect(blank.pending[0]?.answer).toBe("   ");
  });

  it("mints an offline batch only when the server scores it", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db);
    const index = db
      .prepare(`SELECT item_index AS itemIndex FROM practice_sessions WHERE id = ?`)
      .get(session.sessionId) as { itemIndex: number };
    expect(() =>
      issueItemBatch(db, {
        childId: child.id,
        sessionId: session.sessionId,
        idempotencyKey: "batch-too-big",
        count: ISSUE_BATCH_CAP + 1,
        itemIndex: index.itemIndex,
        now: WHEN,
      }),
    ).toThrow(DomainError);
    const before = instanceCount(db, child.id);
    const batch = issueItemBatch(db, {
      childId: child.id,
      sessionId: session.sessionId,
      idempotencyKey: "batch-slot-01",
      count: 3,
      itemIndex: index.itemIndex,
      now: WHEN,
    });
    const retry = issueItemBatch(db, {
      childId: child.id,
      sessionId: session.sessionId,
      idempotencyKey: "batch-slot-01",
      count: 3,
      itemIndex: index.itemIndex,
      now: WHEN,
    });
    expect(retry.map((item) => item.itemInstanceId)).toEqual(batch.map((item) => item.itemInstanceId));
    expect(instanceCount(db, child.id)).toBe(before + 3);
    expect(provisionalVerdict()).toEqual({ pending: true, revealsAnswer: false, mints: false });
    expect(xpCount(db)).toBe(0);
    const first = batch[0];
    if (!first) throw new Error("empty batch");
    const scored = submitAttempt(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "batch-score-01",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: first.itemInstanceId,
        answer: first.canonicalAnswer,
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    expect(scored.correct).toBe(true);
    expect(scored.xpAmount).toBeGreaterThan(0);
  });
});
