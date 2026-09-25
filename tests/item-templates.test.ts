import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { AttemptResult } from "@/lib/attempt-contract";
import { currentAppBuildSha } from "@/lib/app-build";
import { parseAnswer, rationalsEqual } from "@/lib/answer-parser";
import { parseSubmitAttempt, startPracticeSession, submitAnswer, submitAttempt } from "@/lib/attempts";
import { AnswerBlank } from "@/components/answer-blank";
import { PracticeProblem } from "@/components/practice-problem";
import { PracticeFeedback } from "@/components/practice-feedback";
import { openDatabase } from "@/lib/db";
import { DomainError, createChild, createGuardian, getChildHome, setConsent } from "@/lib/domain";
import { publicErrorBody } from "@/lib/http";
import { readParentSummary } from "@/lib/parent-summary";
import { SKILLS, TEMPLATE_VERSIONS, generatedTemplates, newestTemplate } from "@/lib/templates/catalog";
import {
  ambiguousBugs,
  canonicalAllowedForForm,
  classifySlotDraws,
  drawAccepted,
  drawOnce,
  eligibleDraws,
  isProperFraction,
  isWholeCanonical,
  seeded,
  validateTemplate,
} from "@/lib/templates/engine";
import { cueText } from "@/lib/templates/cues";
import {
  exactRepeatRate,
  exhaustionEventCounts,
  formatRejectRates,
  poolIssuanceCounts,
  stepsPracticed,
  TEMPLATE_SHARE_CAP,
  type PoolIssuanceCount,
} from "@/lib/templates/instruments";
import {
  DEFAULT_TEMPLATE_DRAW_WEIGHT,
  ISSUE_BATCH_CAP,
  OUTSTANDING_UNANSWERED_CAP,
  PROGRESSION_DIFFICULTY_STEP,
  TEMPLATE_DRAW_WEIGHTS,
  assignedStepForSkill,
  focusForStoredAnswer,
  gradeStoredAnswer,
  issueForProgression,
  issueItemBatch,
  publicItemForInstance,
  pickOldestExposure,
  presentIssuedItem,
  readItemInstance,
  sessionSlotKey,
  toPublicItem,
  variantsForAssignedStep,
  type ItemInstance,
} from "@/lib/templates/issue";
import { answerKindForTemplate, formatExampleFor } from "@/lib/templates/format-example";
import {
  MIN_PER_SKILL_STEP,
  MIN_PER_TEMPLATE_STEP,
  SKILL_POOL_GAPS,
  TEMPLATE_POOL_GAPS,
  enginePools,
  skillStepPools,
} from "@/lib/templates/pools";
import { ITEM_CATALOG, itemAt } from "@/lib/item-catalog";
import { answersMatch } from "@/lib/templates/rational";
import { ISSUANCE_TEMPLATE_COLUMNS, issuanceTemplateSelect, migrateItemTemplates, seedTemplateVersions } from "@/lib/templates/store";
import type { TemplateVersion } from "@/lib/templates/types";
import { evidenceForSkill, readSkillClientView } from "@/lib/learner-state";
import {
  classifyAttemptFailure,
  createAttemptQueue,
  memoryQueueStore,
  reloadLiveSession,
  type QueuedAttempt,
} from "@/lib/offline-queue";
import { provisionalVerdict } from "@/lib/provisional-verdict";
import { POLICY_VERSION } from "@/lib/policy";
import {
  FORMAT_HINT_COPY,
  formatHint,
  isFormatRejected,
  UNPARSEABLE_BEHAVIOR,
} from "@/lib/unparseable";
import { feedbackFrames } from "@/lib/feedback-frame";
import {
  WRONG_FORM_LOCK_IN,
  WRONG_FORM_ONE_FOCUS,
  WRONG_FORM_WHAT_YOU_TRIED,
  wrongFormCopy,
  type WrongFormRequired,
} from "@/lib/wrong-form-copy";

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

const MAX_SKILL_SWITCH_RATE = 0.1;

type SkillSwitchRate = {
  skill: string;
  issued: number;
  templateSwitch: number;
  exhaustedSwitch: number;
  exhaustedRepeat: number;
  rate: number;
};

/** Switch rate counts template_switch and exhausted_switch, over items requested for that skill. */
function skillSwitchRates(db: Database.Database, childId: string): SkillSwitchRate[] {
  const totals = new Map<
    string,
    { issued: number; templateSwitch: number; exhaustedSwitch: number; exhaustedRepeat: number }
  >();
  for (const pool of poolIssuanceCounts(db, childId)) {
    const row = totals.get(pool.skill) ?? {
      issued: 0,
      templateSwitch: 0,
      exhaustedSwitch: 0,
      exhaustedRepeat: 0,
    };
    row.issued += pool.issued;
    row.templateSwitch += pool.templateSwitch;
    row.exhaustedSwitch += pool.exhaustedSwitch;
    row.exhaustedRepeat += pool.exhaustedRepeat;
    totals.set(pool.skill, row);
  }
  return [...totals.entries()]
    .map(([skill, row]) => ({
      skill,
      ...row,
      rate: row.issued === 0 ? 0 : (row.templateSwitch + row.exhaustedSwitch) / row.issued,
    }))
    .sort((left, right) => (left.skill < right.skill ? -1 : left.skill > right.skill ? 1 : 0));
}

function formatSkillSwitchRate(row: SkillSwitchRate): string {
  const switches = row.templateSwitch + row.exhaustedSwitch;
  return `${row.skill}: ${(row.rate * 100).toFixed(1)}% (${switches}/${row.issued}; template ${row.templateSwitch}, exhausted ${row.exhaustedSwitch})`;
}

type SessionSwitchLog = {
  label: string;
  switches: string[];
};

function skillOfIssued(db: Database.Database, templateId: string, templateVersion: number): string {
  const row = db
    .prepare(
      `SELECT skill_id AS skill FROM item_template_versions
       WHERE template_id = ? AND template_version = ?`,
    )
    .get(templateId, templateVersion) as { skill: string } | undefined;
  if (!row) throw new Error(`missing template ${templateId}@${templateVersion}`);
  return row.skill;
}

function openRotationSession(
  db: Database.Database,
  childId: string,
  sessionId: string,
  startedAt: string,
): void {
  db.prepare(
    `INSERT INTO practice_sessions (
       id, child_id, status, item_index, slot_seq, started_at, practice_lane, phase, policy_version
     ) VALUES (?, ?, 'active', 0, 0, ?, 'recommended', 'practicing', ?)`,
  ).run(sessionId, childId, startedAt, POLICY_VERSION);
}

/** One catalog rotation. Each practice is its own 15-item session. */
function issueRotationWeek(
  db: Database.Database,
  childId: string,
  stampStart: number,
  input: { sessionsPerDay: number; itemsPerSession: number; days: number; keyPrefix: string },
): { stamp: number; sessions: SessionSwitchLog[] } {
  let stamp = stampStart;
  let slot = 0;
  const sessions: SessionSwitchLog[] = [];
  for (let day = 0; day < input.days; day += 1) {
    for (let practice = 0; practice < input.sessionsPerDay; practice += 1) {
      const label = `day ${day + 1} session ${practice + 1}`;
      const sessionId = `${input.keyPrefix}-d${day}-s${practice}`;
      stamp += 1000;
      openRotationSession(db, childId, sessionId, new Date(stamp).toISOString());
      const switches: string[] = [];
      for (let item = 0; item < input.itemsPerSession; item += 1) {
        stamp += 1000;
        const requested = itemAt(slot).skill;
        const issued = issueForProgression(db, {
          childId,
          sessionId,
          skillId: requested,
          idempotencyKey: `${sessionId}-n${item}`,
          now: new Date(stamp).toISOString(),
        });
        slot += 1;
        expect(issued.issueReason, label).not.toBe("exhausted_repeat");
        expect(issued.repeatForced, label).toBe(false);
        expect(issued.difficultyStep, label).toBe(1);
        expect(issued.requestedSkillId, label).toBe(requested);
        const issuedSkill = skillOfIssued(db, issued.templateId, issued.templateVersion);
        const switched =
          issued.issueReason === "template_switch" || issued.issueReason === "exhausted_switch";
        if (issuedSkill !== requested || switched) {
          expect(switched, `${label}: ${requested} -> ${issuedSkill} (${issued.issueReason})`).toBe(true);
          expect(issuedSkill, `${label}: ${requested}`).not.toBe(requested);
          switches.push(`${requested} -> ${issuedSkill} (${issued.issueReason})`);
        }
      }
      sessions.push({ label, switches });
    }
  }
  expect(slot).toBe(input.sessionsPerDay * input.itemsPerSession * input.days);
  return { stamp, sessions };
}

const MIN_DISTINCT_TEMPLATES = 3;

/** Templates the child was issued in this run, grouped by the template's skill. */
function distinctTemplatesBySkill(
  db: Database.Database,
  childId: string,
): Array<{ skill: string; templates: number }> {
  const rows = db
    .prepare(
      `SELECT t.skill_id AS skill,
              COUNT(DISTINCT i.template_id) AS templates
       FROM item_instances i
       JOIN item_template_versions t
         ON t.template_id = i.template_id AND t.template_version = i.template_version
       WHERE i.child_id = ?
       GROUP BY t.skill_id
       ORDER BY skill ASC`,
    )
    .all(childId) as Array<{ skill: string; templates: number }>;
  const seen = new Map(rows.map((row) => [row.skill, row.templates]));
  return ITEM_CATALOG.map((item) => ({ skill: item.skill, templates: seen.get(item.skill) ?? 0 }));
}

function assertDistinctTemplates(db: Database.Database, childId: string): Array<{ skill: string; templates: number }> {
  const rows = distinctTemplatesBySkill(db, childId);
  const short = rows.filter((row) => row.templates < MIN_DISTINCT_TEMPLATES);
  expect(
    short.map((row) => `${row.skill}: ${row.templates} distinct templates`),
    "fewer than 3 distinct templates in the week",
  ).toEqual([]);
  return rows;
}

function medianNumber(values: number[]): number {
  const sorted = values.slice().sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

type CohortResult = {
  worstSessionSwitches: number;
  summary: Array<{
    skill: string;
    overall: number;
    overallText: string;
    templateSwitch: number;
    exhaustedSwitch: number;
    worst: number;
    worstChild: string;
  }>;
  spread: Array<{ skill: string; min: number; median: number; max: number }>;
  perChild: SkillSwitchRate[][];
  shares: TemplateShareRow[];
};

type TemplateShareRow = {
  skill: string;
  templateId: string;
  templateVersion: number;
  issued: number;
  skillIssued: number;
  share: number;
};

function cohortTemplateShares(children: PoolIssuanceCount[][]): TemplateShareRow[] {
  const issued = new Map<string, { skill: string; templateId: string; templateVersion: number; issued: number }>();
  const skillIssued = new Map<string, number>();
  for (const pools of children) {
    for (const pool of pools) {
      skillIssued.set(pool.skill, (skillIssued.get(pool.skill) ?? 0) + pool.issued);
      const key = `${pool.skill}\0${pool.templateId}`;
      const row = issued.get(key) ?? {
        skill: pool.skill,
        templateId: pool.templateId,
        templateVersion: pool.templateVersion,
        issued: 0,
      };
      row.issued += pool.issued;
      issued.set(key, row);
    }
  }
  return [...issued.values()]
    .map((row) => {
      const total = skillIssued.get(row.skill) ?? 0;
      return { ...row, skillIssued: total, share: total === 0 ? 0 : row.issued / total };
    })
    .sort((left, right) =>
      left.skill < right.skill ? -1
      : left.skill > right.skill ? 1
      : left.templateId < right.templateId ? -1
      : left.templateId > right.templateId ? 1
      : 0,
    );
}

function runChildCohort(
  db: Database.Database,
  email: string,
  input: { childPrefix: string; sessionsPerDay: number },
): CohortResult {
  const childCount = 20;
  const guardian = createGuardian(db, {
    email,
    password: "correct-horse",
    timezone: "America/Los_Angeles",
  });
  const insertChild = db.prepare(
    `INSERT INTO children (id, guardian_id, display_name, timezone, created_at)
     VALUES (?, ?, ?, 'America/Los_Angeles', ?)`,
  );
  const perChild: SkillSwitchRate[][] = [];
  const distinctByChild: Array<Array<{ skill: string; templates: number }>> = [];
  const poolsByChild: PoolIssuanceCount[][] = [];
  let worstSessionSwitches = 0;
  for (let index = 0; index < childCount; index += 1) {
    const childId = `${input.childPrefix}-${String(index).padStart(2, "0")}`;
    insertChild.run(childId, guardian.id, `Child ${index}`, WHEN);
    const rotation = issueRotationWeek(db, childId, Date.parse(WHEN), {
      sessionsPerDay: input.sessionsPerDay,
      itemsPerSession: 15,
      days: 7,
      keyPrefix: childId,
    });
    worstSessionSwitches = Math.max(worstSessionSwitches, assertAtMostOneSwitch(rotation.sessions));
    distinctByChild.push(assertDistinctTemplates(db, childId));
    perChild.push(assertRotationLimits(db, childId));
    const pools = poolIssuanceCounts(db, childId);
    const hot = pools.filter((pool) => pool.aboveShareCap);
    expect(
      hot.map((pool) => `${childId} ${pool.skill} ${pool.templateId} ${(pool.share * 100).toFixed(1)}%`),
      "template share above 60%",
    ).toEqual([]);
    poolsByChild.push(pools);
  }
  const skills = perChild[0]?.map((row) => row.skill) ?? [];
  const summary = skills.map((skill) => {
    let issued = 0;
    let templateSwitch = 0;
    let exhaustedSwitch = 0;
    let worstRate = 0;
    let worstChild = "";
    for (let index = 0; index < perChild.length; index += 1) {
      const row = perChild[index]?.find((item) => item.skill === skill);
      if (!row) continue;
      issued += row.issued;
      templateSwitch += row.templateSwitch;
      exhaustedSwitch += row.exhaustedSwitch;
      if (row.rate > worstRate) {
        worstRate = row.rate;
        worstChild = `${input.childPrefix}-${String(index).padStart(2, "0")}`;
      }
    }
    const switches = templateSwitch + exhaustedSwitch;
    return {
      skill,
      overall: issued === 0 ? 0 : switches / issued,
      overallText: `${switches}/${issued}`,
      templateSwitch,
      exhaustedSwitch,
      worst: worstRate,
      worstChild,
    };
  });
  const spread = skills.map((skill) => {
    const counts = distinctByChild.map(
      (rows) => rows.find((row) => row.skill === skill)?.templates ?? 0,
    );
    return {
      skill,
      min: Math.min(...counts),
      median: medianNumber(counts),
      max: Math.max(...counts),
    };
  });
  return { worstSessionSwitches, summary, spread, perChild, shares: cohortTemplateShares(poolsByChild) };
}

function assertCohortLimits(result: CohortResult): void {
  expect(result.worstSessionSwitches).toBeLessThanOrEqual(1);
  const over = result.summary.filter(
    (row) => row.overall > MAX_SKILL_SWITCH_RATE || row.worst > MAX_SKILL_SWITCH_RATE,
  );
  expect(
    over.map(
      (row) =>
        `${row.skill}: overall ${row.overallText}, worst ${(row.worst * 100).toFixed(1)}% (${row.worstChild})`,
    ),
    "cohort switch rate above 10%",
  ).toEqual([]);
  expect(result.summary).toHaveLength(ITEM_CATALOG.length);
  const thin = result.spread.filter((row) => row.min < MIN_DISTINCT_TEMPLATES);
  expect(
    thin.map((row) => `${row.skill}: min ${row.min}`),
    "fewer than 3 distinct templates in a child-week",
  ).toEqual([]);
  const hot = result.shares.filter((row) => row.share > TEMPLATE_SHARE_CAP);
  expect(
    hot.map((row) => `${row.skill} ${row.templateId} ${(row.share * 100).toFixed(1)}%`),
    "cohort template share above 60%",
  ).toEqual([]);
}

function assertAtMostOneSwitch(sessions: SessionSwitchLog[]): number {
  const over = sessions.filter((session) => session.switches.length > 1);
  expect(
    over.map((session) => `${session.label}: ${session.switches.length} (${session.switches.join("; ")})`),
    "more than 1 switch in a session",
  ).toEqual([]);
  return sessions.reduce((max, session) => Math.max(max, session.switches.length), 0);
}

function assertRotationLimits(db: Database.Database, childId: string): SkillSwitchRate[] {
  const rows = db
    .prepare(
      `SELECT template_id AS templateId, operand_key AS operandKey, repeat_forced AS repeatForced
       FROM item_instances WHERE child_id = ?`,
    )
    .all(childId) as Array<{ templateId: string; operandKey: string; repeatForced: number }>;
  const keys = rows.map((row) => `${row.templateId}:${row.operandKey}`);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  expect(duplicate ?? "", "exact repeat").toBe("");
  expect(new Set(keys).size).toBe(keys.length);
  expect(rows.every((row) => row.repeatForced === 0)).toBe(true);
  const rates = skillSwitchRates(db, childId);
  const repeats = rates.filter((row) => row.exhaustedRepeat !== 0);
  expect(
    repeats.map((row) => `${row.skill}: ${row.exhaustedRepeat} exhausted_repeat`),
    "exhausted_repeat",
  ).toEqual([]);
  const over = rates.filter((row) => row.rate > MAX_SKILL_SWITCH_RATE);
  expect(over.map(formatSkillSwitchRate), "switch rate above 10%").toEqual([]);
  return rates;
}

function repeatPoolReport(db: Database.Database, childId: string): string[] {
  const rows = db
    .prepare(
      `SELECT t.skill_id AS skill, i.template_id AS templateId, i.difficulty_step AS step, COUNT(*) AS count
       FROM item_instances i
       JOIN item_template_versions t
         ON t.template_id = i.template_id AND t.template_version = i.template_version
       WHERE i.child_id = ? AND i.issue_reason = 'exhausted_repeat'
       GROUP BY t.skill_id, i.template_id, i.difficulty_step
       ORDER BY t.skill_id ASC, i.template_id ASC, i.difficulty_step ASC`,
    )
    .all(childId) as Array<{ skill: string; templateId: string; step: number; count: number }>;
  return rows.map((row) => `${row.skill} / ${row.templateId} step ${row.step} × ${row.count}`);
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

function examplesDiffer(canonical: string, example: string): boolean {
  const left = parseAnswer(canonical);
  const right = parseAnswer(example);
  if (left.kind === "rational" && right.kind === "rational") {
    return !rationalsEqual(left.value, right.value);
  }
  return example !== canonical.trim();
}

function stubInstance(canonical: string, answerKind: "whole" | "fraction" = "whole"): ItemInstance {
  return {
    itemInstanceId: "inst-example",
    childId: "child",
    sessionId: "session",
    templateId: "add-2d-inline",
    templateVersion: 1,
    difficultyStep: 1,
    operands: {},
    operandKey: "",
    canonicalAnswer: canonical,
    answerLine: canonical,
    prompt: "prompt",
    presentation: {
      layout: "inline",
      blank: "result",
      leading: "",
      trailing: "",
      column: [],
      stepWord: "Warm-up",
    },
    evidenceEligible: true,
    repeatForced: false,
    issueReason: "normal",
    requestedSkillId: null,
    issueIdempotencyKey: "issue-key",
    issuedAt: WHEN,
    consumedAt: null,
    consumedByAttemptKey: null,
    requireForm: null,
    compareMode: "exact",
    bugHits: [],
    defaultFocus: null,
    whyItWorks: null,
    answerKind,
  };
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
      const generatedIds = new Set(
        rows
          .filter((template) => template.version >= 1 && !template.spec.legacy)
          .map((template) => template.templateId),
      );
      expect(generatedIds.size).toBe(generated.length);
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
      issueReason: "normal",
      requestedSkillId: null,
      issueIdempotencyKey: "issue-key",
      issuedAt: WHEN,
      consumedAt: null,
      consumedByAttemptKey: null,
      requireForm: null,
      compareMode: "exact",
      bugHits: [],
      defaultFocus: column.defaultFocus ?? null,
      whyItWorks: null,
      answerKind: "whole",
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
    expect(answersMatch("1/2", "2/4", "rational", "lowest_terms")).toBe("form_mismatch");
    expect(answersMatch("1/2", "1/2", "rational", "lowest_terms")).toBe("correct");
    expect(answersMatch("3/2", "1 1/2", "rational", "improper")).toBe("form_mismatch");
    expect(answersMatch("3/2", "3/2", "rational", "improper")).toBe("correct");
    expect(answersMatch("3/2", "1 1/2", "rational", "mixed")).toBe("correct");
    expect(answersMatch("3/2", "3/2", "rational", "mixed")).toBe("form_mismatch");
    expect(answersMatch("2/4", "1/2", "exact", null)).toBe("incorrect");
    expect(answersMatch("42", "banana", "exact", null)).toBe("unparseable");
    const forms = TEMPLATE_VERSIONS.filter((template) => template.requireForm);
    expect(forms.map((template) => `${template.templateId}:${template.requireForm}`).sort()).toEqual([
      "frac-equiv-improper:improper",
      "frac-equiv-improper:improper",
      "frac-equiv-improper:improper",
      "frac-equiv-improper:improper",
      "frac-equiv-lowest:lowest_terms",
      "frac-equiv-mixed:mixed",
      "frac-equiv-mixed:mixed",
      "frac-equiv-mixed:mixed",
    ]);
  });

  it("keeps the step-1 denominator set when the improper whole part is capped", () => {
    function improper(version: number) {
      const template = TEMPLATE_VERSIONS.find(
        (item) => item.templateId === "frac-equiv-improper" && item.version === version,
      );
      if (!template) throw new Error(`missing frac-equiv-improper@${version}`);
      return template;
    }
    function denominators(version: number): number[] {
      const values = new Set(
        eligibleDraws(improper(version), 1).map((draw) => {
          const slash = draw.canonicalAnswer.lastIndexOf("/");
          return Number(draw.canonicalAnswer.slice(slash + 1));
        }),
      );
      return [...values].sort((left, right) => left - right);
    }
    const version3 = improper(3);
    const version4 = improper(4);
    const step3 = version3.spec.steps.find((variant) => variant.assignedStep === 1);
    const step4 = version4.spec.steps.find((variant) => variant.assignedStep === 1);
    if (!step3 || !step4) throw new Error("missing step 1");
    expect(step4.slots.d).toEqual(step3.slots.d);
    expect(step4.slots.n).toEqual(step3.slots.n);
    expect(step3.slots.whole).toEqual({ min: 1, max: 6 });
    expect(step4.slots.whole).toEqual({ min: 1, max: 3 });
    expect(denominators(4)).toEqual(denominators(3));
    expect(denominators(3)).toEqual([5, 6]);
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
    const opened = readItemInstance(db, session.item.itemInstanceId ?? "");
    if (!opened) throw new Error("session did not issue");
    const seen = new Set<string>();
    let previous = "";
    for (let index = 0; index < 8; index += 1) {
      const issued = issueForProgression(db, {
        childId: child.id,
        sessionId: session.sessionId,
        skillId: SKILLS.add,
        idempotencyKey: `fresh-slot-${index}1`,
        now: new Date(Date.parse(opened.issuedAt) + (index + 1) * 1000).toISOString(),
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
    const { guardian, child, session } = granted(db);
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
    expect(first.issueReason).toBe("normal");
    expect(first.repeatForced).toBe(false);
    expect(second.templateId).not.toBe("add-2d-v0");
    expect(second.issueReason).toBe("exhausted_switch");
    expect(second.evidenceEligible).toBe(true);
    expect(second.difficultyStep).toBe(assignedStepForSkill(SKILLS.sub));
    expect(second.repeatForced).toBe(false);
    expect(second.operandKey).not.toBe(first.operandKey);
    const scored = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "exhaust-switch-score",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: second.itemInstanceId,
        answer: second.canonicalAnswer,
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    if (isFormatRejected(scored)) throw new Error("a readable answer was rejected");
    expect(scored.correct).toBe(true);
    const attempt = db
      .prepare(`SELECT estimator_evidence AS evidence FROM attempts WHERE id = ?`)
      .get(scored.attemptId) as { evidence: number };
    expect(attempt.evidence).toBe(1);
    const rate = exactRepeatRate(db, child.id, WHEN);
    expect(rate.forced).toBe(0);
  });

  it("never issues a whole answer from a mixed require_form template", () => {
    const mixed = newestTemplate("frac-equiv-mixed");
    if (!mixed) throw new Error("missing mixed template");
    const variant = mixed.spec.steps.find((step) => step.assignedStep === 1);
    if (!variant) throw new Error("missing mixed step");
    const raw = Object.values(variant.slots).reduce((count, slot) => count * (slot.max - slot.min + 1), 1);
    const filtered = eligibleDraws(mixed, 1);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(raw);
    expect(filtered.every((draw) => !isWholeCanonical(draw.canonicalAnswer))).toBe(true);
    expect(canonicalAllowedForForm("mixed", "1")).toBe(false);
    expect(canonicalAllowedForForm("mixed", "4/4")).toBe(false);
    expect(canonicalAllowedForForm("mixed", "1 1/2")).toBe(true);
    expect(canonicalAllowedForForm("improper", "1")).toBe(true);
    expect(canonicalAllowedForForm("lowest_terms", "4/4")).toBe(true);

    const names = Object.keys(variant.slots);
    const ranges = names.map((name) => variant.slots[name]!);
    const oracleWhole = (answer: string) => {
      if (/^\d+$/.test(answer)) return true;
      const fraction = answer.match(/^(\d+)\/(\d+)$/);
      if (!fraction) return false;
      const denominator = Number(fraction[2]);
      return denominator > 0 && Number(fraction[1]) % denominator === 0;
    };
    const walk = (index: number, drawn: Record<string, number>) => {
      if (index >= names.length) {
        const answer = oracle("to_mixed", drawn);
        const matched = filtered.some((draw) =>
          names.every((name) => draw.operands[name] === drawn[name]),
        );
        if (answer === null || oracleWhole(answer)) {
          expect(matched).toBe(false);
        }
        if (matched && answer) {
          expect(oracleWhole(answer)).toBe(false);
          expect(isWholeCanonical(answer)).toBe(false);
        }
        return;
      }
      const slot = ranges[index];
      const name = names[index];
      if (!slot || !name) return;
      for (let value = slot.min; value <= slot.max; value += 1) {
        walk(index + 1, { ...drawn, [name]: value });
      }
    };
    walk(0, {});
    const report = validateTemplate(mixed, seeded(11));
    expect(report.rejected, report.reasons.join("; ")).toBe(false);
    for (const step of [1, 2, 3] as const) {
      for (const draw of eligibleDraws(mixed, step)) {
        expect(isWholeCanonical(draw.canonicalAnswer)).toBe(false);
      }
      for (let seed = 1; seed <= 40; seed += 1) {
        const draw = drawAccepted(mixed, step, seeded(seed * 17 + step), 40);
        if (!draw) continue;
        expect(isWholeCanonical(draw.canonicalAnswer)).toBe(false);
      }
    }

    const db = tempDb();
    db.prepare(
      `UPDATE item_template_versions SET active = 0
       WHERE skill_id = ? AND template_id != 'frac-equiv-mixed'`,
    ).run(SKILLS.equiv);
    const { child, session } = granted(db);
    const seen = new Set<string>();
    let previousKey = "";
    for (let index = 0; index < filtered.length; index += 1) {
      const issued = issueForProgression(db, {
        childId: child.id,
        sessionId: session.sessionId,
        skillId: SKILLS.equiv,
        idempotencyKey: `mixed-pool-${index}`,
        now: new Date(Date.parse(WHEN) + index * 1000).toISOString(),
      });
      expect(issued.templateId).toBe("frac-equiv-mixed");
      expect(issued.requireForm).toBe("mixed");
      expect(issued.repeatForced).toBe(false);
      expect(isWholeCanonical(issued.canonicalAnswer)).toBe(false);
      expect(seen.has(issued.operandKey)).toBe(false);
      if (previousKey) expect(issued.operandKey).not.toBe(previousKey);
      previousKey = issued.operandKey;
      seen.add(issued.operandKey);
    }
    expect(seen.size).toBe(filtered.length);
    const switched = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "mixed-pool-switch",
      now: new Date(Date.parse(WHEN) + filtered.length * 1000).toISOString(),
    });
    expect(switched.issueReason).toBe("exhausted_switch");
    expect(switched.templateId).not.toBe("frac-equiv-mixed");
    expect(switched.repeatForced).toBe(false);
    const repeat = exactRepeatRate(db, child.id, switched.issuedAt);
    expect(repeat.forced).toBe(0);
    for (let seed = 0; seed < 12; seed += 1) {
      const fresh = granted(db, `mixed-seed-${seed}@example.com`);
      const issued = issueForProgression(db, {
        childId: fresh.child.id,
        sessionId: fresh.session.sessionId,
        skillId: SKILLS.equiv,
        idempotencyKey: `mixed-seed-${seed}`,
        now: WHEN,
      });
      expect(issued.templateId).toBe("frac-equiv-mixed");
      expect(issued.repeatForced).toBe(false);
      expect(isWholeCanonical(issued.canonicalAnswer)).toBe(false);
    }

    const { child: batchChild, session: batchSession } = granted(db, "batch-mixed@example.com");
    const equivIndex = ITEM_CATALOG.findIndex((item) => item.skill === SKILLS.equiv);
    const batch = issueItemBatch(db, {
      childId: batchChild.id,
      sessionId: batchSession.sessionId,
      count: 3,
      itemIndex: equivIndex,
      idempotencyKey: "mixed-batch",
      now: WHEN,
    });
    const batchRows = batch.map((item) => readItemInstance(db, item.itemInstanceId ?? ""));
    const mixedRows = batchRows.filter((row) => row?.templateId === "frac-equiv-mixed");
    expect(mixedRows.length).toBeGreaterThan(0);
    expect(mixedRows.every((row) => row && !isWholeCanonical(row.canonicalAnswer))).toBe(true);
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
        itemInstanceId: session.item.itemInstanceId,
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
    const beforeBand = readSkillClientView(db, child.id, skill);
    const beforeXp = xpCount(db);
    const beforeFuel = (
      db.prepare(`SELECT COUNT(*) AS count FROM qualifying_events`).get() as { count: number }
    ).count;
    const beforeStreak = streakState(db, child.id);
    const beforeIndex = itemIndex(db, session.sessionId);
    const beforeAttempts = attemptCount(db);
    const beforeDays = qualifyingDays(db, child.id);
    const raw = "banana";
    const example = formatExampleFor(issued.answerKind, issued.canonicalAnswer);
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
      hint: formatHint(example.answerKind, example.formatExample),
    });
    expect(rejected.hint).toBe(
      example.answerKind === "fraction"
        ? `Write it as a fraction, like ${example.formatExample}.`
        : `Use numbers only, like ${example.formatExample}.`,
    );
    expect(rejected.hint).not.toContain(raw);
    expect(examplesDiffer(issued.canonicalAnswer, example.formatExample)).toBe(true);
    expect(rejected).not.toHaveProperty("fuel");
    expect(rejected).not.toHaveProperty("correct");
    expect(rejected).not.toHaveProperty("attemptId");
    expect(rejected).not.toHaveProperty("xpAmount");
    expect(attemptCount(db)).toBe(beforeAttempts);
    expect(db.prepare(`SELECT id FROM attempts WHERE idempotency_key = ?`).get("format-key-0001")).toBeUndefined();
    expect(xpCount(db)).toBe(beforeXp);
    expect(qualifyingDays(db, child.id)).toBe(beforeDays);
    expect(evidenceForSkill(db, child.id, skill)).toEqual(before);
    expect(readSkillClientView(db, child.id, skill)).toEqual(beforeBand);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM qualifying_events`).get() as { count: number }).count).toBe(
      beforeFuel,
    );
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
        `SELECT provenance FROM item_template_versions
         WHERE template_id = ? AND template_version = ?`,
      )
      .get(issued.templateId, issued.templateVersion) as { provenance: string };
    const rejectedRate = formatRejectRates(db, child.id).find(
      (row) => row.templateId === issued.templateId && row.templateVersion === issued.templateVersion,
    );
    expect(rejectedRate).toMatchObject({
      templateId: issued.templateId,
      templateVersion: issued.templateVersion,
      provenance: "seed",
      answerKind: example.answerKind,
      totalRejects: 1,
      distinctRejectedItems: 1,
    });
    expect(rejectedRate?.rate).toBe(
      (rejectedRate?.distinctRejectedItems ?? 0) / (rejectedRate?.servedItems ?? 1),
    );
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
    const scoredRate = formatRejectRates(db, child.id).find(
      (row) => row.templateId === issued.templateId && row.templateVersion === issued.templateVersion,
    );
    expect(scoredRate).toMatchObject({
      totalRejects: 1,
      distinctRejectedItems: 1,
    });
    expect(scoredRate?.rate).toBe(
      (scoredRate?.distinctRejectedItems ?? 0) / (scoredRate?.servedItems ?? 1),
    );
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
    expect(client).not.toContain("format-example");
    expect(client).not.toContain("formatExampleFor");
    expect(client).not.toContain("canonicalAnswer");
    expect(readFileSync(new URL("components/answer-blank.tsx", root), "utf8")).not.toContain(
      "formatExampleFor",
    );
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

  it("stores sequenced reject events that never feed bands or fuel", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db);
    const skill = session.item.skill;
    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: skill,
      idempotencyKey: "format-seq-slot",
      now: WHEN,
    });
    const beforeEvidence = evidenceForSkill(db, child.id, skill);
    const beforeBand = readSkillClientView(db, child.id, skill);
    const beforeXp = xpCount(db);
    const beforeFuel = (
      db.prepare(`SELECT COUNT(*) AS count FROM qualifying_events`).get() as { count: number }
    ).count;
    const raw = "banana";
    const hints: string[] = [];
    for (let seq = 1; seq <= 3; seq += 1) {
      const submittedAt = new Date(Date.parse(WHEN) + seq * 1000).toISOString();
      const rejected = submitAnswer(
        db,
        guardian.id,
        child.id,
        {
          idempotencyKey: `format-seq-000${seq}`,
          sessionId: session.sessionId,
          itemId: session.item.id,
          itemInstanceId: issued.itemInstanceId,
          answer: raw,
          shownAt: shown(),
          submittedAt,
        },
        { now: submittedAt },
      );
      if (!isFormatRejected(rejected)) throw new Error("expected format_rejected");
      hints.push(rejected.hint);
    }
    expect(hints[0]).toBe(hints[1]);
    expect(hints[1]).toBe(hints[2]);
    expect(attemptCount(db)).toBe(0);
    const columns = (db.pragma("table_info(answer_format_rejects)") as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(columns.sort()).toEqual(
      [
        "answer_kind",
        "build_sha",
        "item_instance_id",
        "policy_version",
        "provenance",
        "reject_seq",
        "rejected_at",
        "template_version",
      ].sort(),
    );
    const rows = db
      .prepare(
        `SELECT item_instance_id, template_version, provenance, answer_kind, build_sha,
                policy_version, reject_seq, rejected_at
         FROM answer_format_rejects ORDER BY reject_seq ASC`,
      )
      .all() as Array<{
      item_instance_id: string;
      template_version: number;
      provenance: string;
      answer_kind: string;
      build_sha: string;
      policy_version: string;
      reject_seq: number;
      rejected_at: string;
    }>;
    expect(rows.map((row) => row.reject_seq)).toEqual([1, 2, 3]);
    for (const row of rows) {
      expect(row.item_instance_id).toBe(issued.itemInstanceId);
      expect(row.template_version).toBe(issued.templateVersion);
      expect(row.provenance).toBe("seed");
      expect(row.answer_kind).toBe(issued.answerKind);
      expect(row.build_sha).toBe(currentAppBuildSha());
      expect(row.build_sha.length).toBeGreaterThan(0);
      expect(row.policy_version).toBe(POLICY_VERSION);
      expect(row.rejected_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(JSON.stringify(rows)).not.toContain(raw);
    expect(evidenceForSkill(db, child.id, skill)).toEqual(beforeEvidence);
    expect(readSkillClientView(db, child.id, skill)).toEqual(beforeBand);
    expect(xpCount(db)).toBe(beforeXp);
    expect(
      (db.prepare(`SELECT COUNT(*) AS count FROM qualifying_events`).get() as { count: number }).count,
    ).toBe(beforeFuel);
  });

  it("picks a format example that is never the answer", () => {
    expect(FORMAT_HINT_COPY.whole).toBe("Use numbers only, like {example}.");
    expect(FORMAT_HINT_COPY.fraction).toBe("Write it as a fraction, like {example}.");
    expect(formatHint("whole", "3")).toBe("Use numbers only, like 3.");
    expect(formatHint("fraction", "1/3")).toBe("Write it as a fraction, like 1/3.");
    expect(formatExampleFor("whole", "42")).toEqual({ answerKind: "whole", formatExample: "3" });
    expect(formatExampleFor("whole", "3")).toEqual({ answerKind: "whole", formatExample: "4" });
    expect(formatExampleFor("fraction", "1/3")).toEqual({ answerKind: "fraction", formatExample: "1/2" });
    expect(formatExampleFor("fraction", "1/2")).toEqual({ answerKind: "fraction", formatExample: "1/3" });
    expect(formatExampleFor("fraction", "2/4")).toEqual({ answerKind: "fraction", formatExample: "1/3" });
    expect(formatExampleFor("fraction", "3/6")).toEqual({ answerKind: "fraction", formatExample: "1/3" });
    expect(answerKindForTemplate("add")).toBe("whole");
    expect(answerKindForTemplate("frac_add")).toBe("fraction");

    const swapped = toPublicItem(itemAt(0), stubInstance("2/4", "fraction"));
    expect(swapped.answerKind).toBe("fraction");
    expect(swapped.formatExample).toBe("1/3");
    expect(swapped).not.toHaveProperty("canonicalAnswer");
    expect(JSON.stringify(swapped)).not.toContain("2/4");
    expect(JSON.stringify(swapped)).not.toMatch(
      /build_sha|policy_version|provenance|evidence_eligible|template_version|canonical_answer|canonicalAnswer/,
    );

    const db = tempDb();
    const { child, session } = granted(db);
    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: session.item.skill,
      idempotencyKey: "example-slot-01",
      now: WHEN,
    });
    const catalog = itemAt(itemIndex(db, session.sessionId));
    const published = toPublicItem(catalog, issued);
    const chosen = formatExampleFor(issued.answerKind, issued.canonicalAnswer);
    expect(published.answerKind).toBe(chosen.answerKind);
    expect(published.formatExample).toBe(chosen.formatExample);
    expect(examplesDiffer(issued.canonicalAnswer, published.formatExample ?? "")).toBe(true);
    expect(published).not.toHaveProperty("canonicalAnswer");
    expect(session.item.answerKind).toBe(
      readItemInstance(db, session.item.itemInstanceId ?? "")?.answerKind,
    );
    expect(session.item.formatExample).toBeTruthy();

    const index = itemIndex(db, session.sessionId);
    const batch = issueItemBatch(db, {
      childId: child.id,
      sessionId: session.sessionId,
      idempotencyKey: "example-batch-01",
      count: 3,
      itemIndex: index,
      now: WHEN,
    });
    batch.forEach((instance, offset) => {
      const item = toPublicItem(itemAt(index + offset), instance);
      expect(item.answerKind === "whole" || item.answerKind === "fraction").toBe(true);
      expect(item.formatExample).toBe(
        formatExampleFor(instance.answerKind, instance.canonicalAnswer).formatExample,
      );
      expect(examplesDiffer(instance.canonicalAnswer, item.formatExample ?? "")).toBe(true);
      expect(JSON.stringify(item)).not.toMatch(/canonicalAnswer|canonical_answer/);
    });
  });

  it("keeps a whole-valued fraction template on the fraction keyboard", () => {
    const template = TEMPLATE_VERSIONS.find((item) => item.templateId === "frac-add-like-inline");
    if (!template) throw new Error("missing fraction template");
    expect(answerKindForTemplate(template.spec.family)).toBe("fraction");
    let whole: string | null = null;
    for (let seed = 1; seed <= 40; seed += 1) {
      const drawn = drawAccepted(template, 2, seeded(seed), 40);
      if (!drawn) continue;
      const parsed = parseAnswer(drawn.canonicalAnswer);
      if (parsed.kind === "rational" && parsed.form === "integer") {
        whole = drawn.canonicalAnswer;
        break;
      }
    }
    expect(whole).toBe("1");
    const hinted = formatExampleFor("fraction", whole ?? "");
    expect(hinted).toEqual({ answerKind: "fraction", formatExample: "1/2" });
    expect(examplesDiffer(whole ?? "", hinted.formatExample)).toBe(true);

    const db = tempDb();
    const { guardian, child, session } = granted(db);
    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.addLike,
      idempotencyKey: "whole-frac-slot",
      now: WHEN,
    });
    expect(issued.answerKind).toBe("fraction");
    db.prepare(
      `UPDATE item_instances
       SET canonical_answer = '1', compare_mode = 'rational', require_form = NULL
       WHERE item_instance_id = ?`,
    ).run(issued.itemInstanceId);
    const held = readItemInstance(db, issued.itemInstanceId);
    if (!held) throw new Error("missing instance");
    expect(held.answerKind).toBe("fraction");
    expect(held.canonicalAnswer).toBe("1");
    const published = toPublicItem(itemAt(0), held);
    expect(published.answerKind).toBe("fraction");
    expect(published.formatExample).toBe("1/2");
    expect(examplesDiffer("1", published.formatExample ?? "")).toBe(true);
    expect(published).not.toHaveProperty("canonicalAnswer");

    expect(gradeStoredAnswer(held, "1")).toBe("correct");
    expect(gradeStoredAnswer(held, "4/4")).toBe("correct");
    expect(gradeStoredAnswer({ ...held, requireForm: "lowest_terms" }, "1")).toBe("correct");
    expect(gradeStoredAnswer({ ...held, requireForm: "lowest_terms" }, "4/4")).toBe("form_mismatch");
    expect(gradeStoredAnswer({ ...held, requireForm: "improper" }, "1")).toBe("form_mismatch");

    const scored = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "whole-frac-score",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: held.itemInstanceId,
        answer: "1",
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    if (isFormatRejected(scored)) throw new Error("a whole number on a fraction item was rejected");
    expect(scored.correct).toBe(true);

    const formed = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.addLike,
      idempotencyKey: "whole-frac-form",
      now: WHEN,
    });
    db.prepare(
      `UPDATE item_instances
       SET canonical_answer = '1', compare_mode = 'rational', require_form = 'improper'
       WHERE item_instance_id = ?`,
    ).run(formed.itemInstanceId);
    const later = "2026-06-15T18:00:30.000Z";
    const missed = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "whole-frac-form-score",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: formed.itemInstanceId,
        answer: "1",
        shownAt: new Date(Date.parse(later) - 2_000).toISOString(),
        submittedAt: later,
      },
      { now: later },
    );
    if (isFormatRejected(missed)) throw new Error("require_form marked a readable answer unreadable");
    expect(missed.correct).toBe(false);
    expect(readItemInstance(db, formed.itemInstanceId)?.answerKind).toBe("fraction");
  });

  it("renders the slate hint under the blank and picks the keyboard from answer kind", () => {
    const whole = renderToStaticMarkup(
      createElement(AnswerBlank, {
        value: "banana",
        hint: "Use numbers only, like 3.",
        answerKind: "whole",
        onValueChange: () => undefined,
      }),
    );
    expect(whole).toContain('data-testid="format-hint"');
    expect(whole).toContain("Use numbers only, like 3.");
    expect(whole).toContain('value="banana"');
    expect(whole).toMatch(/inputmode="numeric"/i);
    expect(whole).toContain("text-label");
    expect(whole).not.toMatch(/shake|toast|VerdictStrip|text-destructive|text-primary|MintToast/);

    const fraction = renderToStaticMarkup(
      createElement(AnswerBlank, {
        value: "2/4",
        hint: "Write it as a fraction, like 1/3.",
        answerKind: "fraction",
        onValueChange: () => undefined,
      }),
    );
    expect(fraction).toContain("Write it as a fraction, like 1/3.");
    expect(fraction).toContain('value="2/4"');
    expect(fraction).toMatch(/inputmode="text"/i);
    expect(fraction).toContain('pattern="[0-9]+/[0-9]+"');
    expect(fraction.indexOf('data-testid="practice-answer"')).toBeLessThan(
      fraction.indexOf('data-testid="format-hint"'),
    );
    const cleared = renderToStaticMarkup(
      createElement(AnswerBlank, {
        value: "banana",
        hint: null,
        answerKind: "whole",
        onValueChange: () => undefined,
      }),
    );
    expect(cleared).toContain('value="banana"');
    expect(cleared).not.toContain("format-hint");
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
    const openBeforeScore = db
      .prepare(
        `SELECT COUNT(*) AS count FROM item_instances
         WHERE session_id = ? AND consumed_at IS NULL`,
      )
      .get(session.sessionId) as { count: number };
    expect(openBeforeScore.count).toBe(OUTSTANDING_UNANSWERED_CAP);
    expect(instanceCount(db, child.id)).toBe(before + (OUTSTANDING_UNANSWERED_CAP - 1));
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

  it("stores form_mismatch when the value matches and the form does not", () => {
    const db = tempDb();
    const score = (
      email: string,
      requireForm: "improper" | "lowest_terms",
      canonical: string,
      answer: string,
      key: string,
    ) => {
      const { guardian, child, session } = granted(db, email);
      const issued = issueForProgression(db, {
        childId: child.id,
        sessionId: session.sessionId,
        skillId: SKILLS.equiv,
        idempotencyKey: `${key}-issue`,
        now: WHEN,
      });
      db.prepare(
        `UPDATE item_instances
         SET canonical_answer = ?, require_form = ?, compare_mode = 'rational'
         WHERE item_instance_id = ?`,
      ).run(canonical, requireForm, issued.itemInstanceId);
      const result = submitAnswer(
        db,
        guardian.id,
        child.id,
        {
          idempotencyKey: key,
          sessionId: session.sessionId,
          itemId: session.item.id,
          itemInstanceId: issued.itemInstanceId,
          answer,
          shownAt: shown(),
          submittedAt: WHEN,
        },
        { now: WHEN },
      );
      if (isFormatRejected(result)) throw new Error("a readable answer was rejected");
      const row = db
        .prepare(`SELECT outcome, correct, estimator_evidence FROM attempts WHERE id = ?`)
        .get(result.attemptId) as {
        outcome: string;
        correct: number;
        estimator_evidence: number;
      };
      return { result, row, childId: child.id, skill: issued.templateId };
    };

    const formOnImproper = score("form-improper@example.com", "improper", "4/4", "1", "form-improper");
    const wrongValue = score("wrong-value@example.com", "improper", "4/4", "3/4", "wrong-value");
    const formOnLowest = score("form-lowest@example.com", "lowest_terms", "1", "4/4", "form-lowest");

    expect(formOnImproper.row).toEqual({ outcome: "form_mismatch", correct: 0, estimator_evidence: 1 });
    expect(formOnLowest.row).toEqual({ outcome: "form_mismatch", correct: 0, estimator_evidence: 1 });
    expect(wrongValue.row).toEqual({ outcome: "incorrect", correct: 0, estimator_evidence: 1 });
    expect(formOnImproper.result.correct).toBe(false);
    expect(wrongValue.result.correct).toBe(false);
    expect(formOnImproper.result.lane).toBe(wrongValue.result.lane);
    expect(formOnImproper.result.xpAmount).toBe(wrongValue.result.xpAmount);
    expect(formOnImproper.result.celebrationTier).toBe(wrongValue.result.celebrationTier);
    expect(formOnImproper.result.clientView).toEqual(wrongValue.result.clientView);
    expect(JSON.stringify(formOnImproper.result)).not.toContain("form_mismatch");
    expect(JSON.stringify(formOnLowest.result)).not.toContain("form_mismatch");
    expect(JSON.stringify(wrongValue.result)).not.toContain("form_mismatch");
    const evidence = evidenceForSkill(db, formOnImproper.childId, SKILLS.equiv);
    expect(evidence.map((row) => row.correct)).toEqual([false]);
  });

  it("uses distinct rejected items as the format-reject headline", () => {
    const db = tempDb();
    db.prepare(
      `UPDATE item_template_versions SET active = 0 WHERE template_version = 0 OR template_version >= 2`,
    ).run();
    const { guardian, child, session } = granted(db);
    const first = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "headline-equiv",
      now: WHEN,
    });
    const second = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.add,
      idempotencyKey: "headline-add",
      now: WHEN,
    });
    expect(first.templateVersion).toBe(second.templateVersion);
    expect(first.templateId).not.toBe(second.templateId);
    for (let index = 0; index < 3; index += 1) {
      const rejected = submitAnswer(
        db,
        guardian.id,
        child.id,
        {
          idempotencyKey: `headline-reject-${index}`,
          sessionId: session.sessionId,
          itemId: session.item.id,
          itemInstanceId: first.itemInstanceId,
          answer: "nope",
          shownAt: shown(),
          submittedAt: new Date(Date.parse(WHEN) + index * 1000).toISOString(),
        },
        { now: new Date(Date.parse(WHEN) + index * 1000).toISOString() },
      );
      if (!isFormatRejected(rejected)) throw new Error("expected format_rejected");
    }
    const events = db
      .prepare(`SELECT COUNT(*) AS count FROM answer_format_rejects WHERE item_instance_id = ?`)
      .get(first.itemInstanceId) as { count: number };
    expect(events.count).toBe(3);
    const row = formatRejectRates(db, child.id).find((rate) => rate.templateId === first.templateId);
    const served = db
      .prepare(
        `SELECT COUNT(*) AS count FROM item_instances
         WHERE child_id = ? AND template_id = ? AND template_version = ?`,
      )
      .get(child.id, first.templateId, first.templateVersion) as { count: number };
    expect(row).toMatchObject({
      templateId: first.templateId,
      templateVersion: first.templateVersion,
      provenance: "seed",
      answerKind: first.answerKind,
      totalRejects: 3,
      distinctRejectedItems: 1,
      servedItems: served.count,
    });
    expect(row?.rate).toBe(1 / served.count);
    expect(row?.totalRate).toBe(3 / served.count);
    expect(row?.rate).not.toBe(row?.totalRate);
    const other = formatRejectRates(db, child.id).find((rate) => rate.templateId === second.templateId);
    expect(other?.templateVersion).toBe(first.templateVersion);
    expect(other?.distinctRejectedItems).toBe(0);
    expect(other?.totalRejects).toBe(0);
  });

  it("rejects a missing instance id when the session already issued", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db);
    const beforeXp = xpCount(db);
    const beforeAttempts = attemptCount(db);
    const beforeDays = qualifyingDays(db, child.id);
    const beforeStreak = streakState(db, child.id);
    const beforeFuel = (db.prepare(`SELECT COUNT(*) AS count FROM qualifying_events`).get() as { count: number }).count;
    expect(() =>
      submitAnswer(db, guardian.id, child.id, {
        idempotencyKey: "missing-instance-id",
        sessionId: session.sessionId,
        itemId: session.item.id,
        answer: "42",
        shownAt: shown(),
        submittedAt: WHEN,
      }),
    ).toThrow(/issued problem id is required/);
    let caught: unknown;
    try {
      submitAnswer(db, guardian.id, child.id, {
        idempotencyKey: "missing-instance-body",
        sessionId: session.sessionId,
        itemId: session.item.id,
        answer: "42",
        shownAt: shown(),
        submittedAt: WHEN,
      });
    } catch (error) {
      caught = error;
    }
    expect(publicErrorBody(caught)).toEqual({
      status: 400,
      body: { error: "invalid_attempt", retryable: false },
    });
    expect(() =>
      parseSubmitAttempt({
        idempotencyKey: "bad-instance-format",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: "nope",
        answer: "1",
        shownAt: shown(),
        submittedAt: WHEN,
      }),
    ).toThrow(/not in this practice pack/);
    let invalid: unknown;
    try {
      parseSubmitAttempt({
        idempotencyKey: "bad-instance-body",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: "nope",
        answer: "1",
        shownAt: shown(),
        submittedAt: WHEN,
      });
    } catch (error) {
      invalid = error;
    }
    expect(publicErrorBody(invalid)).toEqual({
      status: 400,
      body: { error: "invalid_attempt", retryable: false },
    });
    expect(attemptCount(db)).toBe(beforeAttempts);
    expect(xpCount(db)).toBe(beforeXp);
    expect(qualifyingDays(db, child.id)).toBe(beforeDays);
    expect(streakState(db, child.id)).toBe(beforeStreak);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM qualifying_events`).get() as { count: number }).count).toBe(
      beforeFuel,
    );
  });

  it("still grades the fixed catalog when the session has no instances", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db);
    db.prepare(`DELETE FROM item_instances WHERE session_id = ?`).run(session.sessionId);
    const scored = submitAttempt(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "legacy-catalog-01",
        sessionId: session.sessionId,
        itemId: "ops-g2-add",
        answer: "42",
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    expect(scored.correct).toBe(true);
    expect(scored.xpAmount).toBeGreaterThan(0);
    expect(scored.lockIn).toBe("27 + 15 = 42");
  });

  it("issues a fresh instance for every slot past the catalog length", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db);
    const start = db
      .prepare(`SELECT slot_seq AS slotSeq FROM practice_sessions WHERE id = ?`)
      .get(session.sessionId) as { slotSeq: number };
    const seen = new Set<string>();
    let currentId = session.item.itemInstanceId ?? "";
    for (let index = 0; index < 25; index += 1) {
      const issued = readItemInstance(db, currentId);
      if (!issued) throw new Error("missing slot");
      expect(seen.has(issued.itemInstanceId)).toBe(false);
      seen.add(issued.itemInstanceId);
      const when = new Date(Date.parse(WHEN) + index * 20_000).toISOString();
      const scored = submitAttempt(
        db,
        guardian.id,
        child.id,
        {
          idempotencyKey: `slot-seq-${index}`,
          sessionId: session.sessionId,
          itemId: session.item.id,
          itemInstanceId: issued.itemInstanceId,
          answer: issued.canonicalAnswer,
          shownAt: new Date(Date.parse(when) - 2_000).toISOString(),
          submittedAt: when,
        },
        { now: when },
      );
      currentId = scored.nextItem.itemInstanceId ?? "";
    }
    expect(seen.size).toBe(25);
    expect(seen.has(currentId)).toBe(false);
    const slot = db
      .prepare(`SELECT slot_seq AS slotSeq, item_index AS itemIndex FROM practice_sessions WHERE id = ?`)
      .get(session.sessionId) as { slotSeq: number; itemIndex: number };
    expect(slot.slotSeq).toBe(start.slotSeq + 25);
    expect(slot.itemIndex).toBe(slot.slotSeq % ITEM_CATALOG.length);
    const again = presentIssuedItem(db, child.id, session.sessionId, slot.slotSeq);
    expect(again.itemInstanceId).toBe(currentId);
    const retry = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: again.skill,
      idempotencyKey: sessionSlotKey(session.sessionId, slot.slotSeq),
      now: WHEN,
    });
    expect(retry.itemInstanceId).toBe(currentId);
  });

  it("adds template versions that were missing from an older database", () => {
    const db = tempDb();
    const before = db.prepare(`SELECT COUNT(*) AS count FROM item_template_versions`).get() as { count: number };
    db.prepare(`DELETE FROM item_template_versions WHERE template_id = 'frac-equiv-lowest'`).run();
    expect(
      (db.prepare(`SELECT COUNT(*) AS count FROM item_template_versions WHERE template_id = 'frac-equiv-lowest'`).get() as { count: number }).count,
    ).toBe(0);
    seedTemplateVersions(db);
    const after = db.prepare(`SELECT COUNT(*) AS count FROM item_template_versions`).get() as { count: number };
    expect(after.count).toBe(before.count);
    expect(
      (db.prepare(`SELECT COUNT(*) AS count FROM item_template_versions WHERE template_id = 'frac-equiv-lowest'`).get() as { count: number }).count,
    ).toBe(1);
  });

  it("throws when an existing template version has a different content hash", () => {
    const db = tempDb();
    db.prepare(
      `UPDATE item_template_versions SET content_hash = 'tampered' WHERE template_id = 'add-2d-inline'`,
    ).run();
    expect(() => seedTemplateVersions(db)).toThrow(/content_hash does not match the spec/);
  });

  it("draws only proper fractions on lowest_terms step 1", () => {
    const lowest = TEMPLATE_VERSIONS.find((template) => template.templateId === "frac-equiv-lowest");
    if (!lowest) throw new Error("missing lowest template");
    const stepOne = eligibleDraws(lowest, 1);
    expect(stepOne.length).toBeGreaterThan(0);
    expect(stepOne.every((draw) => isProperFraction(draw.canonicalAnswer))).toBe(true);
    const report = validateTemplate(lowest, seeded(5));
    expect(report.rejected, report.reasons.join("; ")).toBe(false);
    for (let seed = 1; seed <= 40; seed += 1) {
      const draw = drawAccepted(lowest, 1, seeded(seed), 40);
      if (!draw) continue;
      expect(isProperFraction(draw.canonicalAnswer)).toBe(true);
    }
    const variant = lowest.spec.steps.find((step) => step.assignedStep === 1);
    if (!variant) throw new Error("missing lowest step");
    const names = Object.keys(variant.slots);
    const ranges = names.map((name) => variant.slots[name]!);
    const walk = (index: number, drawn: Record<string, number>) => {
      if (index >= names.length) {
        const answer = oracle("lowest", drawn);
        const matched = stepOne.some((draw) => names.every((name) => draw.operands[name] === drawn[name]));
        if (answer && !isProperFraction(answer)) expect(matched).toBe(false);
        if (matched && answer) expect(isProperFraction(answer)).toBe(true);
        return;
      }
      const slot = ranges[index];
      const name = names[index];
      if (!slot || !name) return;
      for (let value = slot.min; value <= slot.max; value += 1) {
        walk(index + 1, { ...drawn, [name]: value });
      }
    };
    walk(0, {});
    expect(eligibleDraws(lowest, 2).some((draw) => !isProperFraction(draw.canonicalAnswer))).toBe(true);
  });

  it("forces the oldest exposure when the lowest-terms step 1 pool is exhausted", () => {
    const lowest = TEMPLATE_VERSIONS.find((template) => template.templateId === "frac-equiv-lowest");
    if (!lowest) throw new Error("missing lowest template");
    const filtered = eligibleDraws(lowest, 1);
    expect(filtered).toHaveLength(7);
    expect(filtered.every((draw) => isProperFraction(draw.canonicalAnswer))).toBe(true);
    const db = tempDb();
    db.prepare(
      `UPDATE item_template_versions SET active = 0
       WHERE skill_id = ? AND template_id != 'frac-equiv-lowest'`,
    ).run(SKILLS.equiv);
    const { child, session } = granted(db);
    const seen = new Set<string>();
    let previousKey = "";
    for (let index = 0; index < filtered.length; index += 1) {
      const issued = issueForProgression(db, {
        childId: child.id,
        sessionId: session.sessionId,
        skillId: SKILLS.equiv,
        idempotencyKey: `lowest-pool-${index}`,
        now: new Date(Date.parse(WHEN) + index * 1000).toISOString(),
      });
      expect(issued.templateId).toBe("frac-equiv-lowest");
      expect(issued.issueReason).toBe("normal");
      expect(issued.repeatForced).toBe(false);
      expect(isProperFraction(issued.canonicalAnswer)).toBe(true);
      expect(seen.has(issued.operandKey)).toBe(false);
      if (previousKey) expect(issued.operandKey).not.toBe(previousKey);
      previousKey = issued.operandKey;
      seen.add(issued.operandKey);
    }
    expect(seen.size).toBe(7);
    const switched = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "lowest-pool-switch",
      now: new Date(Date.parse(WHEN) + filtered.length * 1000).toISOString(),
    });
    expect(switched.issueReason).toBe("exhausted_switch");
    expect(switched.templateId).not.toBe("frac-equiv-lowest");
    expect(switched.difficultyStep).toBe(1);
    expect(switched.repeatForced).toBe(false);
  });

  it("accepts a reduced mixed number on lowest_terms", () => {
    expect(answersMatch("3/2", "1 1/2", "rational", "lowest_terms")).toBe("correct");
    const db = tempDb();
    const { guardian, child, session } = granted(db);
    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "lowest-mixed-ok",
      now: WHEN,
    });
    db.prepare(
      `UPDATE item_instances
       SET canonical_answer = '3/2', answer_line = '3/2', require_form = 'lowest_terms', compare_mode = 'rational'
       WHERE item_instance_id = ?`,
    ).run(issued.itemInstanceId);
    const scored = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "lowest-mixed-score",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: "1 1/2",
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    if (isFormatRejected(scored)) throw new Error("a readable answer was rejected");
    expect(scored.correct).toBe(true);
  });

  it("stores form_mismatch for an unreduced mixed number on lowest_terms", () => {
    expect(answersMatch("3/2", "1 2/4", "rational", "lowest_terms")).toBe("form_mismatch");
    const db = tempDb();
    const { guardian, child, session } = granted(db);
    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "lowest-mixed-bad",
      now: WHEN,
    });
    db.prepare(
      `UPDATE item_instances
       SET canonical_answer = '3/2', answer_line = '3/2', require_form = 'lowest_terms', compare_mode = 'rational'
       WHERE item_instance_id = ?`,
    ).run(issued.itemInstanceId);
    const scored = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "lowest-mixed-miss",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: "1 2/4",
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    if (isFormatRejected(scored)) throw new Error("a readable answer was rejected");
    expect(scored.correct).toBe(false);
    const row = db.prepare(`SELECT outcome, correct FROM attempts WHERE id = ?`).get(scored.attemptId) as {
      outcome: string;
      correct: number;
    };
    expect(row).toEqual({ outcome: "form_mismatch", correct: 0 });
    expect(JSON.stringify(scored)).not.toContain("form_mismatch");
  });

  it("accepts a whole number written over one on lowest_terms", () => {
    expect(answersMatch("3", "3/1", "rational", "lowest_terms")).toBe("correct");
    expect(answersMatch("3", "1", "rational", "lowest_terms")).toBe("incorrect");
    expect(answersMatch("1", "1", "rational", "lowest_terms")).toBe("correct");
    const db = tempDb();
    const { guardian, child, session } = granted(db);
    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "lowest-over-one",
      now: WHEN,
    });
    db.prepare(
      `UPDATE item_instances
       SET canonical_answer = '3', answer_line = '3', require_form = 'lowest_terms', compare_mode = 'rational'
       WHERE item_instance_id = ?`,
    ).run(issued.itemInstanceId);
    const scored = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "lowest-over-one-score",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: "3/1",
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    if (isFormatRejected(scored)) throw new Error("a readable answer was rejected");
    expect(scored.correct).toBe(true);
    expect(scored.lockIn).toBe("3");
    expect(scored.lockIn).not.toContain("3/1");
  });

  it("stops issuing once a session has three unanswered instances", () => {
    const db = tempDb();
    const { child, session } = granted(db);
    const index = db
      .prepare(`SELECT item_index AS itemIndex FROM practice_sessions WHERE id = ?`)
      .get(session.sessionId) as { itemIndex: number };
    const unanswered = () =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM item_instances
             WHERE session_id = ? AND consumed_at IS NULL`,
          )
          .get(session.sessionId) as { count: number }
      ).count;
    expect(unanswered()).toBe(1);
    const first = issueItemBatch(db, {
      childId: child.id,
      sessionId: session.sessionId,
      idempotencyKey: "cap-batch-a",
      count: ISSUE_BATCH_CAP,
      itemIndex: index.itemIndex,
      now: WHEN,
    });
    expect(first).toHaveLength(OUTSTANDING_UNANSWERED_CAP - 1);
    expect(unanswered()).toBe(OUTSTANDING_UNANSWERED_CAP);
    const second = issueItemBatch(db, {
      childId: child.id,
      sessionId: session.sessionId,
      idempotencyKey: "cap-batch-b",
      count: ISSUE_BATCH_CAP,
      itemIndex: index.itemIndex,
      now: WHEN,
    });
    const third = issueItemBatch(db, {
      childId: child.id,
      sessionId: session.sessionId,
      idempotencyKey: "cap-batch-c",
      count: 1,
      itemIndex: index.itemIndex,
      now: WHEN,
    });
    expect(second).toEqual([]);
    expect(third).toEqual([]);
    expect(unanswered()).toBe(OUTSTANDING_UNANSWERED_CAP);
    expect(instanceCount(db, child.id)).toBe(OUTSTANDING_UNANSWERED_CAP);
    const current = readItemInstance(db, session.item.itemInstanceId ?? "");
    expect(current?.consumedAt).toBeNull();
  });

  it("drops a queued attempt with no instance id after one 400 and keeps syncing", async () => {
    const stale: QueuedAttempt = {
      idempotencyKey: "queued-no-instance",
      childId: "child-1",
      sessionId: "session-1",
      itemId: "ops-g2-add",
      answer: "17",
      shownAt: shown(),
      submittedAt: WHEN,
    };
    const later: QueuedAttempt = {
      ...stale,
      idempotencyKey: "queued-with-instance",
      itemInstanceId: "issued-instance-01",
      answer: "42",
    };
    const queue = createAttemptQueue(memoryQueueStore());
    queue.enqueue(stale);
    queue.enqueue(later);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let posts = 0;
    const snapshot = await queue.reconcile(async (attempt) => {
      posts += 1;
      if (!attempt.itemInstanceId) {
        const classified = classifyAttemptFailure(400, { error: "invalid_attempt", retryable: false });
        if (!classified) throw new Error("expected a permanent invalid_attempt");
        return classified;
      }
      return { ok: true as const, result: syncedAttempt(attempt.idempotencyKey) };
    });
    expect(posts).toBe(2);
    expect(snapshot.pending).toEqual([]);
    expect(snapshot.dropped).toEqual([
      { idempotencyKey: stale.idempotencyKey, childId: stale.childId, sessionId: stale.sessionId },
    ]);
    expect(JSON.stringify(snapshot.dropped)).not.toContain(stale.answer);
    expect(snapshot.synced.map((result) => result.idempotencyKey)).toEqual([later.idempotencyKey]);
    expect(snapshot.invalidAttemptKeys).toEqual([stale.idempotencyKey]);
    expect(warn).toHaveBeenCalledWith(`Dropped queued attempt ${stale.idempotencyKey}`);
    expect(warn.mock.calls.flat().join(" ")).not.toContain(stale.answer);
    warn.mockRestore();

    let replayed = 0;
    const again = await queue.reconcile(async () => {
      replayed += 1;
      return { ok: true as const, result: syncedAttempt(later.idempotencyKey) };
    });
    expect(replayed).toBe(0);
    expect(again.pending).toEqual([]);
    expect(again.dropped).toHaveLength(1);
  });

  it("retries a 5xx from the offline queue", async () => {
    const attempt: QueuedAttempt = {
      idempotencyKey: "queued-server-error",
      childId: "child-1",
      sessionId: "session-1",
      itemId: "ops-g2-add",
      answer: "42",
      shownAt: shown(),
      submittedAt: WHEN,
      itemInstanceId: "issued-instance-01",
    };
    const queue = createAttemptQueue(memoryQueueStore());
    queue.enqueue(attempt);
    let posts = 0;
    const waiting = await queue.reconcile(async () => {
      posts += 1;
      const classified = classifyAttemptFailure(500, { error: "Something went wrong." });
      if (!classified) throw new Error("expected a retryable server error");
      return classified;
    });
    expect(posts).toBe(1);
    expect(waiting.pending).toHaveLength(1);
    expect(waiting.dropped).toEqual([]);
    expect(waiting.invalidAttemptKeys).toBeUndefined();
    const reload = vi.fn();
    expect(reloadLiveSession(attempt.idempotencyKey, waiting, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    const synced = await queue.reconcile(async () => ({
      ok: true as const,
      result: syncedAttempt(attempt.idempotencyKey),
    }));
    expect(posts).toBe(1);
    expect(synced.pending).toEqual([]);
    expect(synced.synced.map((result) => result.idempotencyKey)).toEqual([attempt.idempotencyKey]);
  });

  it("reloads the live session when a queued try is permanently invalid", () => {
    const reload = vi.fn();
    const snapshot = {
      version: 1 as const,
      pending: [],
      blocked: [],
      dropped: [],
      synced: [],
      invalidAttemptKeys: ["live-waiting-key"],
    };
    expect(reloadLiveSession("live-waiting-key", snapshot, reload)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(reloadLiveSession(null, snapshot, reload)).toBe(false);
    expect(reloadLiveSession("other-key", snapshot, reload)).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("returns a wrong_form reason for each required form", () => {
    const cases: Array<{
      required: WrongFormRequired;
      canonical: string;
      answer: string;
      typed: string;
    }> = [
      { required: "lowest_terms", canonical: "1/2", answer: "2 / 4", typed: "2/4" },
      { required: "improper", canonical: "3/2", answer: "1 1/2", typed: "1 1/2" },
      { required: "mixed", canonical: "1 1/2", answer: "3/2", typed: "3/2" },
    ];
    const db = tempDb();
    for (const sample of cases) {
      const { guardian, child, session } = granted(db, `${sample.required}@example.com`);
      const issued = issueForProgression(db, {
        childId: child.id,
        sessionId: session.sessionId,
        skillId: SKILLS.equiv,
        idempotencyKey: `shape-${sample.required}`,
        now: WHEN,
      });
      db.prepare(
        `UPDATE item_instances
         SET canonical_answer = ?, answer_line = ?, require_form = ?, compare_mode = 'rational'
         WHERE item_instance_id = ?`,
      ).run(sample.canonical, sample.canonical, sample.required, issued.itemInstanceId);
      const scored = submitAnswer(
        db,
        guardian.id,
        child.id,
        {
          idempotencyKey: `shape-score-${sample.required}`,
          sessionId: session.sessionId,
          itemId: session.item.id,
          itemInstanceId: issued.itemInstanceId,
          answer: sample.answer,
          shownAt: shown(),
          submittedAt: WHEN,
        },
        { now: WHEN },
      );
      if (isFormatRejected(scored)) throw new Error("a readable answer was rejected");
      const copy = wrongFormCopy({
        typed: sample.typed,
        canonical: sample.canonical,
        required: sample.required,
      });
      expect(scored.reason).toEqual({ kind: "wrong_form", required: sample.required });
      expect(Object.keys(scored.reason ?? {}).sort()).toEqual(["kind", "required"]);
      expect(scored.correct).toBe(false);
      expect(scored.whatWentWell).toBe(copy.whatWentWell);
      expect(scored.whatWentWell).toBe(
        WRONG_FORM_WHAT_YOU_TRIED.replaceAll("{typed}", sample.typed),
      );
      expect(scored.whatWentWell).not.toMatch(/lowest terms|whole number|fraction/);
      expect(scored.oneFocus).toBe(
        WRONG_FORM_ONE_FOCUS[sample.required].replaceAll("{canonical}", sample.canonical),
      );
      expect(scored.tryNext).toBe("");
      expect(scored.lockIn).toBe(
        WRONG_FORM_LOCK_IN.replaceAll("{typed}", sample.typed).replaceAll(
          "{canonical}",
          sample.canonical,
        ),
      );
      expect(JSON.stringify(scored)).not.toContain("form_mismatch");
      const stored = db
        .prepare(`SELECT beats_json FROM attempts WHERE id = ?`)
        .get(scored.attemptId) as { beats_json: string };
      expect(Object.keys(JSON.parse(stored.beats_json) as object).sort()).toEqual([
        "lockIn",
        "oneFocus",
        "tryNext",
        "whatWentWell",
      ]);
    }
  });

  it("keeps the existing Not-yet copy when the value is wrong", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db, "wrong-amount@example.com");
    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "wrong-amount-issue",
      now: WHEN,
    });
    db.prepare(
      `UPDATE item_instances
       SET canonical_answer = '1/2', answer_line = '1/2', require_form = 'lowest_terms', compare_mode = 'rational'
       WHERE item_instance_id = ?`,
    ).run(issued.itemInstanceId);
    const scored = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "wrong-amount-score",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: "3/4",
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    if (isFormatRejected(scored)) throw new Error("a readable answer was rejected");
    expect(scored.reason).toBeUndefined();
    expect(scored.whatWentWell).toBe("You committed to an answer.");
    expect(scored.lockIn).toBe("1/2");
    expect(scored.lockIn).not.toBe("3/4 = 1/2");
    expect(scored.correct).toBe(false);
    const frames = feedbackFrames(scored);
    expect(frames.map((frame) => frame.label)).toEqual([
      "What you tried",
      "One focus",
      "Try next",
      "Lock in",
    ]);
  });

  it("renders wrong-form copy for each required form", () => {
    const cases: Array<{ required: WrongFormRequired; canonical: string; answer: string }> = [
      { required: "lowest_terms", canonical: "1/2", answer: "2/4" },
      { required: "improper", canonical: "3/2", answer: "1 1/2" },
      { required: "mixed", canonical: "1 1/2", answer: "3/2" },
    ];
    const db = tempDb();
    for (const sample of cases) {
      const { guardian, child, session } = granted(db, `render-${sample.required}@example.com`);
      const issued = issueForProgression(db, {
        childId: child.id,
        sessionId: session.sessionId,
        skillId: SKILLS.equiv,
        idempotencyKey: `render-${sample.required}`,
        now: WHEN,
      });
      db.prepare(
        `UPDATE item_instances
         SET canonical_answer = ?, answer_line = ?, require_form = ?, compare_mode = 'rational'
         WHERE item_instance_id = ?`,
      ).run(sample.canonical, sample.canonical, sample.required, issued.itemInstanceId);
      const scored = submitAnswer(
        db,
        guardian.id,
        child.id,
        {
          idempotencyKey: `render-score-${sample.required}`,
          sessionId: session.sessionId,
          itemId: session.item.id,
          itemInstanceId: issued.itemInstanceId,
          answer: sample.answer,
          shownAt: shown(),
          submittedAt: WHEN,
        },
        { now: WHEN },
      );
      if (isFormatRejected(scored)) throw new Error("a readable answer was rejected");
      const frames = feedbackFrames(scored);
      expect(frames.map((frame) => frame.label)).toEqual(["What you tried", "One focus", "Lock in"]);
      const html = renderToStaticMarkup(
        createElement(PracticeFeedback, { feedback: scored, item: scored.nextItem }),
      );
      expect(html).toContain('data-testid="verdict-strip"');
      expect(html).toContain('data-correct="false"');
      expect(html).toContain("Not yet");
      expect(html).toContain("text-verdict-miss");
      expect(html).not.toContain("text-verdict-correct");
      expect(html).not.toContain(">Correct<");
      const triedAt = html.indexOf('data-testid="beat-whatWentWell"');
      const focusAt = html.indexOf('data-testid="beat-oneFocus"');
      const tried = html.slice(triedAt, focusAt);
      expect(tried).toContain('data-ink="body"');
      expect(tried).toContain("text-foreground");
      expect(tried).toContain("That&#x27;s the right amount!");
      expect(tried).not.toContain("verdict-correct");
      expect(html).toContain(scored.oneFocus.replaceAll("'", "&#x27;"));
      expect(html).toContain(scored.lockIn);
      expect(html).toContain('data-beat-label="What you tried"');
      expect(html).toContain('data-beat-label="One focus"');
      expect(html).toContain('data-beat-label="Lock in"');
      expect(html).not.toContain('data-beat-label="Try next"');
      expect(html).not.toContain("A sprout for that try.");
      expect(html).toContain("A quiet sprout. This one stays small.");
    }
  });

  it("keeps the wrong-form verdict blue and mints like a wrong-value miss", () => {
    const db = tempDb();
    const scoreMiss = (email: string, answer: string, key: string) => {
      const { guardian, child, session } = granted(db, email);
      const before = db
        .prepare(`SELECT streak_state, last_qualifying_day FROM learner_progress WHERE child_id = ?`)
        .get(child.id) as { streak_state: string | null; last_qualifying_day: string | null };
      const issued = issueForProgression(db, {
        childId: child.id,
        sessionId: session.sessionId,
        skillId: SKILLS.equiv,
        idempotencyKey: `${key}-issue`,
        now: WHEN,
      });
      db.prepare(
        `UPDATE item_instances
         SET canonical_answer = '1/2', answer_line = '1/2', require_form = 'lowest_terms', compare_mode = 'rational'
         WHERE item_instance_id = ?`,
      ).run(issued.itemInstanceId);
      const scored = submitAnswer(
        db,
        guardian.id,
        child.id,
        {
          idempotencyKey: `${key}-score`,
          sessionId: session.sessionId,
          itemId: session.item.id,
          itemInstanceId: issued.itemInstanceId,
          answer,
          shownAt: shown(),
          submittedAt: WHEN,
        },
        { now: WHEN },
      );
      if (isFormatRejected(scored)) throw new Error("a readable answer was rejected");
      const streak = db
        .prepare(`SELECT streak_state, last_qualifying_day FROM learner_progress WHERE child_id = ?`)
        .get(child.id) as { streak_state: string | null; last_qualifying_day: string | null };
      return { guardian, child, session, issued, scored, before, streak };
    };
    const formMiss = scoreMiss("form-mint@example.com", "2/4", "form-mint");
    const valueMiss = scoreMiss("value-mint@example.com", "3/4", "value-mint");
    const scored = formMiss.scored;
    expect(scored.correct).toBe(false);
    expect(scored.celebrationTier).toBe(valueMiss.scored.celebrationTier);
    expect(scored.xpAmount).toBe(valueMiss.scored.xpAmount);
    expect(scored.xpAmount).toBeGreaterThan(0);
    expect(scored.eventIds).toHaveLength(valueMiss.scored.eventIds.length);
    expect(scored.fuel.credit).toBe(valueMiss.scored.fuel.credit);
    expect(Boolean(scored.fuel.heatEventId)).toBe(Boolean(valueMiss.scored.fuel.heatEventId));
    expect(scored.fuel.pieceEventIds).toHaveLength(valueMiss.scored.fuel.pieceEventIds.length);
    expect(xpCount(db, scored.attemptId)).toBe(xpCount(db, valueMiss.scored.attemptId));
    expect(formMiss.streak).toEqual(valueMiss.streak);
    expect(formMiss.streak.last_qualifying_day).not.toBe(formMiss.before.last_qualifying_day);
    const consumed = db
      .prepare(`SELECT consumed_at FROM item_instances WHERE item_instance_id = ?`)
      .get(formMiss.issued.itemInstanceId) as { consumed_at: string | null };
    expect(consumed.consumed_at).not.toBeNull();
    const evidence = evidenceForSkill(db, formMiss.child.id, SKILLS.equiv);
    expect(evidence).toEqual([{ correct: false, lane: "celebrate", practiceLane: "recommended" }]);
    expect(() =>
      submitAnswer(
        db,
        formMiss.guardian.id,
        formMiss.child.id,
        {
          idempotencyKey: "no-mint-retry",
          sessionId: formMiss.session.sessionId,
          itemId: formMiss.session.item.id,
          itemInstanceId: formMiss.issued.itemInstanceId,
          answer: "1/2",
          shownAt: shown(),
          submittedAt: WHEN,
        },
        { now: WHEN },
      ),
    ).toThrow(DomainError);
    const html = renderToStaticMarkup(
      createElement(PracticeFeedback, { feedback: scored, item: scored.nextItem }),
    );
    expect(html).toContain('data-correct="false"');
    expect(html).toContain("Not yet");
    expect(html).toContain("text-verdict-miss");
    expect(html).not.toContain("text-verdict-correct");
  });

  it("allows only the wrong_form reason on the child payload", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db, "leak-form@example.com");
    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "leak-form-issue",
      now: WHEN,
    });
    db.prepare(
      `UPDATE item_instances
       SET canonical_answer = '1/2', answer_line = '1/2', require_form = 'lowest_terms', compare_mode = 'rational'
       WHERE item_instance_id = ?`,
    ).run(issued.itemInstanceId);
    const scored = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "leak-form-score",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: issued.itemInstanceId,
        answer: "2/4",
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    if (isFormatRejected(scored)) throw new Error("a readable answer was rejected");
    expect(scored.reason).toEqual({ kind: "wrong_form", required: "lowest_terms" });
    expect(Object.keys(scored.reason ?? {})).toEqual(["kind", "required"]);
    const { reason, ...rest } = scored;
    const sealed = [JSON.stringify(scored), JSON.stringify(rest), JSON.stringify(reason)].join("\n");
    expect(sealed).not.toMatch(
      /form_mismatch|build_sha|policy_version|buildSha|policyVersion|provenance|evidence_eligible|evidenceEligible|computed_step|computedStep|assigned_step|assignedStep|parent_prior|parentPrior|template_version|templateVersion|canonical_answer|canonicalAnswer/,
    );
    const html = renderToStaticMarkup(
      createElement(PracticeFeedback, { feedback: scored, item: scored.nextItem }),
    );
    expect(html).not.toContain("form_mismatch");
    expect(html).not.toContain("canonical_answer");
  });

  it("replays the same wrong_form reason", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db, "replay-form@example.com");
    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "replay-form-issue",
      now: WHEN,
    });
    db.prepare(
      `UPDATE item_instances
       SET canonical_answer = '1/2', answer_line = '1/2', require_form = 'lowest_terms', compare_mode = 'rational'
       WHERE item_instance_id = ?`,
    ).run(issued.itemInstanceId);
    const input = {
      idempotencyKey: "replay-form-score",
      sessionId: session.sessionId,
      itemId: session.item.id,
      itemInstanceId: issued.itemInstanceId,
      answer: "2/4",
      shownAt: shown(),
      submittedAt: WHEN,
    };
    const first = submitAnswer(db, guardian.id, child.id, input, { now: WHEN });
    const replay = submitAnswer(db, guardian.id, child.id, input, { now: WHEN });
    if (isFormatRejected(first) || isFormatRejected(replay)) {
      throw new Error("a readable answer was rejected");
    }
    expect(replay.replayed).toBe(true);
    expect(replay.reason).toEqual(first.reason);
    expect(replay.reason).toEqual({ kind: "wrong_form", required: "lowest_terms" });
    expect(replay.whatWentWell).toBe(first.whatWentWell);
    expect(replay.oneFocus).toBe(first.oneFocus);
    expect(replay.lockIn).toBe(first.lockIn);
    expect(replay.lockIn).toBe("2/4 = 1/2");
    const attempts = db.prepare(`SELECT COUNT(*) AS count FROM attempts WHERE child_id = ?`).get(child.id) as {
      count: number;
    };
    expect(attempts.count).toBe(1);
    expect(xpCount(db, first.attemptId)).toBe(xpCount(db, replay.attemptId));
    expect(replay.xpAmount).toBe(first.xpAmount);
    expect(replay.xpAmount).toBeGreaterThan(0);
  });

  it("gives blank, unreadable, and too-fast answers no wrong_form reason", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db, "no-reason@example.com");
    const issue = (key: string) => {
      const issued = issueForProgression(db, {
        childId: child.id,
        sessionId: session.sessionId,
        skillId: SKILLS.equiv,
        idempotencyKey: key,
        now: WHEN,
      });
      db.prepare(
        `UPDATE item_instances
         SET canonical_answer = '1/2', answer_line = '1/2', require_form = 'lowest_terms', compare_mode = 'rational'
         WHERE item_instance_id = ?`,
      ).run(issued.itemInstanceId);
      return issued;
    };
    const blankItem = issue("no-reason-blank-issue");
    const blank = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "no-reason-blank-score",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: blankItem.itemInstanceId,
        answer: "   ",
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    if (isFormatRejected(blank)) throw new Error("a blank answer was rejected as unreadable");
    expect(blank.flags).toContain("empty_answer");
    expect(blank.reason).toBeUndefined();

    const unreadableItem = issue("no-reason-unreadable-issue");
    const rejected = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "no-reason-unreadable-score",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: unreadableItem.itemInstanceId,
        answer: "nope",
        shownAt: shown(),
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    if (!isFormatRejected(rejected)) throw new Error("expected format_rejected");
    expect(rejected).not.toHaveProperty("reason");
    const rejects = db
      .prepare(`SELECT COUNT(*) AS count FROM answer_format_rejects WHERE item_instance_id = ?`)
      .get(unreadableItem.itemInstanceId) as { count: number };
    expect(rejects.count).toBe(1);
    const attemptsForReject = db
      .prepare(`SELECT COUNT(*) AS count FROM attempts WHERE item_instance_id = ?`)
      .get(unreadableItem.itemInstanceId) as { count: number };
    expect(attemptsForReject.count).toBe(0);

    const fastItem = issue("no-reason-fast-issue");
    const tooFast = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "no-reason-fast-score",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: fastItem.itemInstanceId,
        answer: "2/4",
        shownAt: WHEN,
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    if (isFormatRejected(tooFast)) throw new Error("a readable answer was rejected");
    expect(tooFast.flags).toContain("too_fast");
    expect(tooFast.reason).toBeUndefined();
    const stored = db
      .prepare(`SELECT outcome, beats_json FROM attempts WHERE id = ?`)
      .get(tooFast.attemptId) as { outcome: string; beats_json: string };
    expect(stored.outcome).toBe("form_mismatch");
    expect(stored.beats_json).not.toContain("wrong_form");
  });

  it("keeps the wrong_form reason when an offline try syncs and replays", async () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db, "offline-form@example.com");
    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "offline-form-issue",
      now: WHEN,
    });
    db.prepare(
      `UPDATE item_instances
       SET canonical_answer = '1/2', answer_line = '1/2', require_form = 'lowest_terms', compare_mode = 'rational'
       WHERE item_instance_id = ?`,
    ).run(issued.itemInstanceId);
    const queued = {
      idempotencyKey: "offline-form-score",
      childId: child.id,
      sessionId: session.sessionId,
      itemId: session.item.id,
      itemInstanceId: issued.itemInstanceId,
      answer: "2/4",
      shownAt: shown(),
      submittedAt: WHEN,
    };
    const queue = createAttemptQueue(memoryQueueStore());
    expect(queue.enqueue(queued).pending).toHaveLength(1);
    const synced = await queue.reconcile(async (attempt) => {
      const result = submitAnswer(
        db,
        guardian.id,
        child.id,
        {
          idempotencyKey: attempt.idempotencyKey,
          sessionId: attempt.sessionId,
          itemId: attempt.itemId,
          itemInstanceId: attempt.itemInstanceId,
          answer: attempt.answer,
          shownAt: attempt.shownAt,
          submittedAt: attempt.submittedAt,
        },
        { now: WHEN },
      );
      if (isFormatRejected(result)) return { ok: false as const, reason: "format_rejected" as const, rejected: result };
      return { ok: true as const, result };
    });
    expect(synced.pending).toEqual([]);
    expect(synced.synced).toHaveLength(1);
    expect(synced.synced[0]?.reason).toEqual({ kind: "wrong_form", required: "lowest_terms" });
    const replay = submitAnswer(db, guardian.id, child.id, queued, { now: WHEN });
    if (isFormatRejected(replay)) throw new Error("a readable answer was rejected");
    expect(replay.replayed).toBe(true);
    expect(replay.reason).toEqual({ kind: "wrong_form", required: "lowest_terms" });
    const stored = db
      .prepare(`SELECT beats_json FROM attempts WHERE child_id = ?`)
      .get(child.id) as { beats_json: string };
    expect(JSON.parse(stored.beats_json)).not.toHaveProperty("reason");
  });

  it("keeps a frozen wrong_form reason when a later template version changes the form rule", () => {
    const attemptsSource = readFileSync(path.join(process.cwd(), "lib/attempts.ts"), "utf8");
    const reader = attemptsSource.slice(
      attemptsSource.indexOf("function wrongFormReasonFromAttempt"),
      attemptsSource.indexOf("function resultFromRow"),
    );
    expect(reader).toContain("FROM item_instances");
    expect(reader).not.toContain("item_template_versions");
    expect(reader).not.toContain("readItemInstance");

    const db = tempDb();
    const { guardian, child, session } = granted(db, "frozen-form@example.com");
    db.prepare(
      `UPDATE item_template_versions SET active = 0
       WHERE skill_id = ? AND template_id != 'frac-equiv-lowest'`,
    ).run(SKILLS.equiv);
    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "frozen-form-issue",
      now: WHEN,
    });
    const frozen = db
      .prepare(
        `SELECT template_id, template_version, require_form, compare_mode
         FROM item_instances WHERE item_instance_id = ?`,
      )
      .get(issued.itemInstanceId) as {
      template_id: string;
      template_version: number;
      require_form: string | null;
      compare_mode: string;
    };
    expect(frozen.template_id).toBe("frac-equiv-lowest");
    expect(frozen.require_form).toBe("lowest_terms");
    expect(frozen.compare_mode).toBe("rational");
    db.prepare(
      `UPDATE item_instances SET canonical_answer = '1/2', answer_line = '1/2'
       WHERE item_instance_id = ?`,
    ).run(issued.itemInstanceId);
    const input = {
      idempotencyKey: "frozen-form-score",
      sessionId: session.sessionId,
      itemId: session.item.id,
      itemInstanceId: issued.itemInstanceId,
      answer: "2/4",
      shownAt: shown(),
      submittedAt: WHEN,
    };
    const first = submitAnswer(db, guardian.id, child.id, input, { now: WHEN });
    if (isFormatRejected(first)) throw new Error("a readable answer was rejected");
    expect(first.reason).toEqual({ kind: "wrong_form", required: "lowest_terms" });

    db.prepare(
      `UPDATE item_template_versions SET active = 0, require_form = 'mixed'
       WHERE template_id = ? AND template_version = ?`,
    ).run(frozen.template_id, frozen.template_version);
    db.prepare(
      `INSERT INTO item_template_versions (
         template_id, template_version, skill_id, prompt_shape, spec_json, bug_rules_json,
         default_focus, why_it_works, require_form, provenance, evidence_eligible,
         parent_prior_grade, parent_prior_difficulty, active, promoted, content_hash
       )
       SELECT template_id, template_version + 1, skill_id, prompt_shape, spec_json, bug_rules_json,
              default_focus, why_it_works, 'improper', provenance, evidence_eligible,
              parent_prior_grade, parent_prior_difficulty, 1, promoted, 'bumped-' || content_hash
       FROM item_template_versions
       WHERE template_id = ? AND template_version = ?`,
    ).run(frozen.template_id, frozen.template_version);
    const live = db
      .prepare(
        `SELECT template_version, require_form, active
         FROM item_template_versions WHERE template_id = ? ORDER BY template_version`,
      )
      .all(frozen.template_id) as Array<{
      template_version: number;
      require_form: string | null;
      active: number;
    }>;
    expect(live).toEqual([
      { template_version: frozen.template_version, require_form: "mixed", active: 0 },
      { template_version: frozen.template_version + 1, require_form: "improper", active: 1 },
    ]);

    const replay = submitAnswer(db, guardian.id, child.id, input, { now: WHEN });
    if (isFormatRejected(replay)) throw new Error("a readable answer was rejected");
    expect(replay.replayed).toBe(true);
    expect(replay.reason).toEqual({ kind: "wrong_form", required: "lowest_terms" });
    const stillFrozen = db
      .prepare(`SELECT require_form FROM item_instances WHERE item_instance_id = ?`)
      .get(issued.itemInstanceId) as { require_form: string | null };
    expect(stillFrozen.require_form).toBe("lowest_terms");
  });

  it("returns reason null when the instance has no frozen form", () => {
    const db = tempDb();
    const { guardian, child, session } = granted(db, "unfrozen-form@example.com");
    const issued = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "unfrozen-form-issue",
      now: WHEN,
    });
    const frozen = db
      .prepare(
        `SELECT template_id, template_version FROM item_instances WHERE item_instance_id = ?`,
      )
      .get(issued.itemInstanceId) as { template_id: string; template_version: number };
    db.prepare(
      `UPDATE item_instances
       SET canonical_answer = '1/2', answer_line = '1/2', require_form = NULL, compare_mode = 'rational'
       WHERE item_instance_id = ?`,
    ).run(issued.itemInstanceId);
    const input = {
      idempotencyKey: "unfrozen-form-score",
      sessionId: session.sessionId,
      itemId: session.item.id,
      itemInstanceId: issued.itemInstanceId,
      answer: "2/4",
      shownAt: shown(),
      submittedAt: WHEN,
    };
    const first = submitAnswer(db, guardian.id, child.id, input, { now: WHEN });
    if (isFormatRejected(first)) throw new Error("a readable answer was rejected");
    expect(first.reason).toBeNull();
    expect(first.correct).toBe(true);

    db.prepare(
      `UPDATE item_template_versions SET active = 0, require_form = 'mixed'
       WHERE template_id = ? AND template_version = ?`,
    ).run(frozen.template_id, frozen.template_version);
    db.prepare(
      `INSERT INTO item_template_versions (
         template_id, template_version, skill_id, prompt_shape, spec_json, bug_rules_json,
         default_focus, why_it_works, require_form, provenance, evidence_eligible,
         parent_prior_grade, parent_prior_difficulty, active, promoted, content_hash
       )
       SELECT template_id, template_version + 1, skill_id, prompt_shape, spec_json, bug_rules_json,
              default_focus, why_it_works, 'improper', provenance, evidence_eligible,
              parent_prior_grade, parent_prior_difficulty, 1, promoted, 'unfrozen-' || content_hash
       FROM item_template_versions
       WHERE template_id = ? AND template_version = ?`,
    ).run(frozen.template_id, frozen.template_version);

    const replay = submitAnswer(db, guardian.id, child.id, input, { now: WHEN });
    if (isFormatRejected(replay)) throw new Error("a readable answer was rejected");
    expect(replay.replayed).toBe(true);
    expect(replay.reason).toBeNull();
    expect(replay.correct).toBe(true);
    const stored = db
      .prepare(`SELECT outcome FROM attempts WHERE id = ?`)
      .get(first.attemptId) as { outcome: string };
    expect(stored.outcome).toBe("correct");
  });

  it("returns reason null for an old attempt with no instance", () => {
    const attemptsSource = readFileSync(path.join(process.cwd(), "lib/attempts.ts"), "utf8");
    const reader = attemptsSource.slice(
      attemptsSource.indexOf("function wrongFormReasonFromAttempt"),
      attemptsSource.indexOf("function resultFromRow"),
    );
    expect(reader.indexOf("if (!row.item_instance_id) return null")).toBeGreaterThan(-1);
    expect(reader.indexOf("if (!row.item_instance_id) return null")).toBeLessThan(reader.indexOf("answersMatch"));
    expect(reader).toContain("row.outcome != null");

    const db = tempDb();
    const { guardian, child, session } = granted(db, "no-instance-reason@example.com");
    db.prepare(`DELETE FROM item_instances WHERE session_id = ?`).run(session.sessionId);
    const input = {
      idempotencyKey: "old-attempt-no-instance",
      sessionId: session.sessionId,
      itemId: session.item.id,
      answer: "42",
      shownAt: shown(),
      submittedAt: WHEN,
    };
    const first = submitAnswer(db, guardian.id, child.id, input, { now: WHEN });
    if (isFormatRejected(first)) throw new Error("a readable answer was rejected");
    expect(first.reason).toBeNull();
    const stored = db
      .prepare(`SELECT item_instance_id AS instanceId, outcome FROM attempts WHERE id = ?`)
      .get(first.attemptId) as { instanceId: string | null; outcome: string };
    expect(stored.instanceId).toBeNull();
    const replay = submitAnswer(db, guardian.id, child.id, input, { now: WHEN });
    if (isFormatRejected(replay)) throw new Error("a readable answer was rejected");
    expect(replay.replayed).toBe(true);
    expect(replay.reason).toBeNull();
    expect(replay.correct).toBe(first.correct);
  });

  it("keeps every step-1 template and skill pool at the floor except the allowlist", () => {
    const pools = enginePools();
    expect(pools.length).toBeGreaterThan(0);
    const stepOne = pools.filter((pool) => pool.step === 1);
    expect(TEMPLATE_POOL_GAPS.every((gap) => gap.step === 1)).toBe(true);
    const gaps = new Map(
      TEMPLATE_POOL_GAPS.map((gap) => [`${gap.templateId}@${gap.version}#${gap.step}`, gap.reason]),
    );
    for (const pool of stepOne) {
      const key = `${pool.templateId}@${pool.version}#${pool.step}`;
      const reason = gaps.get(key);
      if (reason) {
        expect(reason.length, key).toBeGreaterThan(0);
        expect(pool.size, key).toBeLessThan(MIN_PER_TEMPLATE_STEP);
      } else {
        expect(pool.size, `${pool.skill} ${key}`).toBeGreaterThanOrEqual(MIN_PER_TEMPLATE_STEP);
      }
    }
    expect([...gaps.keys()].sort()).toEqual(
      stepOne
        .filter((pool) => pool.size < MIN_PER_TEMPLATE_STEP)
        .map((pool) => `${pool.templateId}@${pool.version}#${pool.step}`)
        .sort(),
    );
    const newestMixed = pools.find(
      (pool) => pool.templateId === "frac-equiv-mixed" && pool.version === 3 && pool.step === 1,
    );
    const lowest = pools.find((pool) => pool.templateId === "frac-equiv-lowest" && pool.step === 1);
    expect(newestMixed?.size).toBe(2);
    expect(lowest?.size).toBe(7);
    for (const template of TEMPLATE_VERSIONS) {
      for (const variant of template.spec.steps) {
        const audit = classifySlotDraws(template, variant.assignedStep);
        expect(audit.matchesOtherStep, `${template.templateId}@${template.version}#${variant.assignedStep}`).toBe(0);
        expect(audit.matchesNoStep, `${template.templateId}@${template.version}#${variant.assignedStep}`).toBe(0);
      }
    }

    const skills = skillStepPools().filter((pool) => pool.step === 1);
    expect(SKILL_POOL_GAPS.every((gap) => gap.step === 1)).toBe(true);
    const skillGaps = new Map(SKILL_POOL_GAPS.map((gap) => [`${gap.skill}#${gap.step}`, gap.reason]));
    for (const pool of skills) {
      const key = `${pool.skill}#${pool.step}`;
      const reason = skillGaps.get(key);
      if (reason) {
        expect(reason.length, key).toBeGreaterThan(0);
        expect(pool.size, key).toBeLessThan(MIN_PER_SKILL_STEP);
      } else {
        expect(pool.size, key).toBeGreaterThanOrEqual(MIN_PER_SKILL_STEP);
      }
    }
    expect([...skillGaps.keys()].sort()).toEqual(
      skills
        .filter((pool) => pool.size < MIN_PER_SKILL_STEP)
        .map((pool) => `${pool.skill}#${pool.step}`)
        .sort(),
    );
    expect(skills.find((pool) => pool.skill === SKILLS.compare && pool.step === 1)?.size).toBe(19);
  });

  it("switches skills before repeating, and never issues a harder step", () => {
    const db = tempDb();
    const { child, session } = granted(db);
    db.prepare(
      `UPDATE item_template_versions SET active = 0
       WHERE skill_id = ? AND template_id != 'frac-equiv-lowest'`,
    ).run(SKILLS.equiv);
    const beforeProgress = db.prepare(`SELECT * FROM learner_progress WHERE child_id = ?`).all(child.id);
    const beforeSkills = db.prepare(`SELECT * FROM learner_skill_state WHERE child_id = ?`).all(child.id);
    expect(beforeProgress).toEqual([expect.objectContaining({ difficulty_step: 0 })]);
    const lowest = newestTemplate("frac-equiv-lowest");
    if (!lowest) throw new Error("missing lowest template");
    const pool = eligibleDraws(lowest, 1);
    expect(eligibleDraws(lowest, 2).length).toBeGreaterThan(0);
    const filled: string[] = [];
    for (let index = 0; index < pool.length; index += 1) {
      const issued = issueForProgression(db, {
        childId: child.id,
        sessionId: session.sessionId,
        skillId: SKILLS.equiv,
        idempotencyKey: `order-fill-${index}`,
        now: new Date(Date.parse(WHEN) + index * 1000).toISOString(),
      });
      expect(issued.issueReason).toBe("normal");
      expect(issued.templateId).toBe("frac-equiv-lowest");
      expect(issued.difficultyStep).toBe(1);
      expect(issued.evidenceEligible).toBe(true);
      filled.push(issued.operandKey);
    }
    const switched = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "order-switch",
      now: new Date(Date.parse(WHEN) + pool.length * 1000).toISOString(),
    });
    expect(switched.issueReason).toBe("exhausted_switch");
    expect(switched.templateId).not.toBe("frac-equiv-lowest");
    expect(switched.difficultyStep).toBe(1);
    expect(switched.evidenceEligible).toBe(true);
    expect(switched.repeatForced).toBe(false);
    const switchedSkill = db
      .prepare(
        `SELECT skill_id AS skill FROM item_template_versions
         WHERE template_id = ? AND template_version = ?`,
      )
      .get(switched.templateId, switched.templateVersion) as { skill: string };
    expect(switchedSkill.skill).not.toBe(SKILLS.equiv);
    const switchedCatalog = ITEM_CATALOG.find((item) => item.skill === switchedSkill.skill);
    if (!switchedCatalog) throw new Error("missing switched catalog item");
    const switchHtml = renderToStaticMarkup(
      createElement(PracticeProblem, { item: toPublicItem(switchedCatalog, switched) }),
    );
    expect(switchHtml).toContain(`data-testid="concept-name">${switchedSkill.skill}</span>`);
    expect(switchHtml).toContain("Warm-up");
    expect(switchHtml).not.toContain("mint-toast");
    expect(switchHtml).not.toMatch(/Level up|level-up|Switched|switched to/);
    expect(JSON.stringify(toPublicItem(switchedCatalog, switched))).not.toMatch(
      /issue_reason|issueReason|template_switch|exhausted_switch|exhausted_repeat|exhausted_stepup|switchRate|poolIssuance|evidence_eligible|evidenceEligible/,
    );

    db.prepare(`UPDATE item_template_versions SET active = 0 WHERE template_id != 'frac-equiv-lowest'`).run();
    const repeated = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "order-repeat",
      now: new Date(Date.parse(WHEN) + (pool.length + 1) * 1000).toISOString(),
    });
    expect(repeated.issueReason).toBe("exhausted_repeat");
    expect(repeated.templateId).toBe("frac-equiv-lowest");
    expect(repeated.templateVersion).toBe(lowest.version);
    expect(repeated.difficultyStep).toBe(1);
    expect(repeated.repeatForced).toBe(true);
    expect(repeated.evidenceEligible).toBe(false);
    expect(repeated.operandKey).toBe(filled[0]);
    const harder = db
      .prepare(`SELECT COUNT(*) AS count FROM item_instances WHERE child_id = ? AND difficulty_step > 1`)
      .get(child.id) as { count: number };
    expect(harder.count).toBe(0);
    expect(assignedStepForSkill(SKILLS.equiv)).toBe(PROGRESSION_DIFFICULTY_STEP);
    expect(db.prepare(`SELECT * FROM learner_progress WHERE child_id = ?`).all(child.id)).toEqual(beforeProgress);
    expect(db.prepare(`SELECT * FROM learner_skill_state WHERE child_id = ?`).all(child.id)).toEqual(beforeSkills);
    const counts = exhaustionEventCounts(db, child.id);
    expect(counts.filter((row) => row.reason === "exhausted_switch")).toHaveLength(1);
    expect(counts.filter((row) => row.reason === "exhausted_repeat")).toEqual([
      expect.objectContaining({
        skill: SKILLS.equiv,
        templateId: "frac-equiv-lowest",
        templateVersion: lowest.version,
        step: 1,
        count: 1,
      }),
    ]);
    const lowestPool = poolIssuanceCounts(db, child.id).find(
      (row) => row.templateId === "frac-equiv-lowest" && row.step === 1,
    );
    expect(lowestPool).toEqual(
      expect.objectContaining({
        skill: SKILLS.equiv,
        templateVersion: lowest.version,
        issued: pool.length + 1,
        templateSwitch: 0,
        exhaustedSwitch: 0,
        exhaustedRepeat: 1,
        switchRate: 0,
      }),
    );
    const switchedPool = poolIssuanceCounts(db, child.id).find(
      (row) => row.templateId === switched.templateId && row.templateVersion === switched.templateVersion,
    );
    expect(switchedPool?.exhaustedSwitch).toBe(1);
    expect(switchedPool?.switchRate).toBe(1 / (switchedPool?.issued ?? 1));
    expect(repeatPoolReport(db, child.id)).toEqual([
      `${SKILLS.equiv} / frac-equiv-lowest step 1 × 1`,
    ]);
  });

  it("records no evidence when a repeat is answered correctly", () => {
    const db = tempDb();
    db.prepare(`UPDATE item_template_versions SET active = 0 WHERE template_id != 'sub-2d-v0'`).run();
    const { guardian, child, session } = granted(db);
    const original = readItemInstance(db, session.item.itemInstanceId ?? "");
    if (!original) throw new Error("session did not issue");
    expect(original.issueReason).toBe("exhausted_switch");
    expect(original.templateId).toBe("sub-2d-v0");
    expect(original.evidenceEligible).toBe(true);
    const originalAt = new Date(Date.parse(original.issuedAt) + 3_000).toISOString();
    const originalScore = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "repeat-original-score",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: original.itemInstanceId,
        answer: original.canonicalAnswer,
        shownAt: new Date(Date.parse(originalAt) - 2_000).toISOString(),
        submittedAt: originalAt,
      },
      { now: originalAt },
    );
    if (isFormatRejected(originalScore)) throw new Error("a readable answer was rejected");
    expect(originalScore.correct).toBe(true);
    const originalAttempt = db
      .prepare(`SELECT estimator_evidence AS evidence FROM attempts WHERE id = ?`)
      .get(originalScore.attemptId) as { evidence: number };
    expect(originalAttempt.evidence).toBe(1);
    const evidenceAfterOriginal = evidenceForSkill(db, child.id, SKILLS.sub);
    expect(evidenceAfterOriginal).toHaveLength(1);
    const skillStateAfterOriginal = db
      .prepare(`SELECT * FROM learner_skill_state WHERE child_id = ? ORDER BY skill`)
      .all(child.id);

    const repeated = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.sub,
      idempotencyKey: "repeat-no-evidence",
      now: new Date(Date.parse(originalAt) + 1_000).toISOString(),
    });
    expect(repeated.issueReason).toBe("exhausted_repeat");
    expect(repeated.itemInstanceId).not.toBe(original.itemInstanceId);
    expect(repeated.operandKey).toBe(original.operandKey);
    expect(repeated.difficultyStep).toBe(1);
    const issuedFlag = db
      .prepare(`SELECT evidence_eligible AS eligible FROM item_instances WHERE item_instance_id = ?`)
      .get(repeated.itemInstanceId) as { eligible: number };
    expect(issuedFlag.eligible).toBe(0);
    const originalFlag = db
      .prepare(`SELECT evidence_eligible AS eligible FROM item_instances WHERE item_instance_id = ?`)
      .get(original.itemInstanceId) as { eligible: number };
    expect(originalFlag.eligible).toBe(1);
    db.prepare(`UPDATE item_template_versions SET active = 1 WHERE template_id != 'sub-2d-v0'`).run();

    const repeatAt = new Date(Date.parse(repeated.issuedAt) + 3_000).toISOString();
    const scored = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "repeat-no-evidence-score",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: repeated.itemInstanceId,
        answer: repeated.canonicalAnswer,
        shownAt: new Date(Date.parse(repeatAt) - 2_000).toISOString(),
        submittedAt: repeatAt,
      },
      { now: repeatAt },
    );
    if (isFormatRejected(scored)) throw new Error("a readable answer was rejected");
    expect(scored.correct).toBe(true);
    const repeatAttempt = db
      .prepare(`SELECT estimator_evidence AS evidence FROM attempts WHERE id = ?`)
      .get(scored.attemptId) as { evidence: number };
    expect(repeatAttempt.evidence).toBe(0);
    expect(evidenceForSkill(db, child.id, SKILLS.sub)).toEqual(evidenceAfterOriginal);
    expect(
      db.prepare(`SELECT * FROM learner_skill_state WHERE child_id = ? ORDER BY skill`).all(child.id),
    ).toEqual(skillStateAfterOriginal);
    expect(
      (db.prepare(`SELECT estimator_evidence AS evidence FROM attempts WHERE id = ?`).get(originalScore.attemptId) as {
        evidence: number;
      }).evidence,
    ).toBe(1);
    const catalog = ITEM_CATALOG.find((item) => item.skill === SKILLS.sub);
    if (!catalog) throw new Error("missing subtract catalog item");
    const payload = JSON.stringify(toPublicItem(catalog, repeated));
    const sealed = [payload, JSON.stringify(scored), JSON.stringify(scored.clientView)].join("\n");
    expect(sealed).not.toMatch(/evidence_eligible|evidenceEligible/);
    const home = getChildHome(db, guardian.id, child.id);
    const summary = readParentSummary(db, guardian.id, child.id, repeatAt);
    const surfaces = JSON.stringify({ home, summary });
    expect(surfaces).not.toMatch(/switchRate|poolIssuance|exhaustedSwitch|evidence_eligible|evidenceEligible/);
  });

  it("keeps the saved band when a correct repeat follows a miss", () => {
    const db = tempDb();
    db.prepare(`UPDATE item_template_versions SET active = 0 WHERE template_id != 'sub-2d-v0'`).run();
    const { guardian, child, session } = granted(db, "repeat-band@example.com");
    const original = readItemInstance(db, session.item.itemInstanceId ?? "");
    if (!original) throw new Error("session did not issue");
    expect(original.evidenceEligible).toBe(true);
    expect(original.templateId).toBe("sub-2d-v0");
    const missAt = new Date(Date.parse(original.issuedAt) + 3_000).toISOString();
    const wrong = original.canonicalAnswer === "0" ? "1" : "0";
    const missed = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "repeat-band-miss",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: original.itemInstanceId,
        answer: wrong,
        shownAt: new Date(Date.parse(missAt) - 2_000).toISOString(),
        submittedAt: missAt,
      },
      { now: missAt },
    );
    if (isFormatRejected(missed)) throw new Error("a readable answer was rejected");
    expect(missed.correct).toBe(false);
    expect(missed.clientView.bandLabel).toBe("Still learning");
    const saved = readSkillClientView(db, child.id, SKILLS.sub);
    expect(saved?.bandLabel).toBe("Still learning");
    const storedAfterMiss = db
      .prepare(`SELECT * FROM learner_skill_state WHERE child_id = ? AND skill = ?`)
      .get(child.id, SKILLS.sub);

    const repeated = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.sub,
      idempotencyKey: "repeat-band-issue",
      now: new Date(Date.parse(missAt) + 1_000).toISOString(),
    });
    expect(repeated.issueReason).toBe("exhausted_repeat");
    expect(repeated.evidenceEligible).toBe(false);
    expect(repeated.requestedSkillId).toBe(SKILLS.sub);
    expect(repeated.difficultyStep).toBe(1);
    expect(repeated.presentation.stepWord).toBe("Warm-up");
    const progressAfterMiss = db
      .prepare(`SELECT difficulty_step AS step FROM learner_progress WHERE child_id = ?`)
      .get(child.id);
    const boundaryAfterMiss = (
      db.prepare(`SELECT COUNT(*) AS count FROM boundary_events WHERE child_id = ?`).get(child.id) as {
        count: number;
      }
    ).count;
    db.prepare(`UPDATE item_template_versions SET active = 1 WHERE template_id != 'sub-2d-v0'`).run();
    const repeatAt = new Date(Date.parse(repeated.issuedAt) + 3_000).toISOString();
    const scored = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "repeat-band-correct",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: repeated.itemInstanceId,
        answer: repeated.canonicalAnswer,
        shownAt: new Date(Date.parse(repeatAt) - 2_000).toISOString(),
        submittedAt: repeatAt,
      },
      { now: repeatAt },
    );
    if (isFormatRejected(scored)) throw new Error("a readable answer was rejected");
    expect(scored.correct).toBe(true);
    expect(scored.clientView.bandLabel).toBe("Still learning");
    expect(scored.celebrationTier).toBe("full");
    const storedView = db
      .prepare(`SELECT client_view_json AS view FROM attempts WHERE id = ?`)
      .get(scored.attemptId) as { view: string };
    expect(JSON.parse(storedView.view).bandLabel).toBe("Still learning");
    expect(readSkillClientView(db, child.id, SKILLS.sub)).toEqual(saved);
    expect(
      db.prepare(`SELECT * FROM learner_skill_state WHERE child_id = ? AND skill = ?`).get(child.id, SKILLS.sub),
    ).toEqual(storedAfterMiss);
    const kinds = (
      db.prepare(`SELECT kind FROM qualifying_events WHERE attempt_id = ? ORDER BY rowid`).all(scored.attemptId) as Array<{
        kind: string;
      }>
    ).map((row) => row.kind);
    expect(kinds).toContain("HonestAttempt");
    expect(kinds).not.toContain("ConceptProgressTick");
    expect(kinds).not.toContain("MasteryBandTransition");
    expect(kinds).not.toContain("BadgeMilestone");
    expect(scored.xpAmount).toBeGreaterThan(0);
    expect(scored.fuel?.credit).toBeGreaterThan(0);
    expect(
      db.prepare(`SELECT difficulty_step AS step FROM learner_progress WHERE child_id = ?`).get(child.id),
    ).toEqual(progressAfterMiss);
    expect(
      (db.prepare(`SELECT COUNT(*) AS count FROM boundary_events WHERE child_id = ?`).get(child.id) as {
        count: number;
      }).count,
    ).toBe(boundaryAfterMiss);
    const attemptStep = db
      .prepare(`SELECT difficulty_step AS step FROM attempts WHERE id = ?`)
      .get(scored.attemptId) as { step: number };
    expect(attemptStep.step).toBe(1);
  });

  it("drops a replay of a repeat without recording evidence", () => {
    const db = tempDb();
    db.prepare(`UPDATE item_template_versions SET active = 0 WHERE template_id != 'sub-2d-v0'`).run();
    const { guardian, child, session } = granted(db);
    const first = readItemInstance(db, session.item.itemInstanceId ?? "");
    if (!first) throw new Error("session did not issue");
    expect(first.issueReason).toBe("exhausted_switch");
    expect(first.templateId).toBe("sub-2d-v0");
    expect(first.difficultyStep).toBe(1);
    const repeated = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.sub,
      idempotencyKey: "repeat-evidence",
      now: new Date(Date.parse(first.issuedAt) + 1000).toISOString(),
    });
    expect(repeated.issueReason).toBe("exhausted_repeat");
    expect(repeated.difficultyStep).toBe(1);
    expect(repeated.operandKey).toBe(first.operandKey);
    expect(repeated.itemInstanceId).not.toBe(first.itemInstanceId);
    expect(repeated.evidenceEligible).toBe(false);
    expect(assignedStepForSkill(SKILLS.sub)).toBe(PROGRESSION_DIFFICULTY_STEP);
    const submittedAt = new Date(Date.parse(repeated.issuedAt) + 3_000).toISOString();
    const scored = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "repeat-evidence-score",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: repeated.itemInstanceId,
        answer: repeated.canonicalAnswer,
        shownAt: new Date(Date.parse(submittedAt) - 2_000).toISOString(),
        submittedAt,
      },
      { now: submittedAt },
    );
    if (isFormatRejected(scored)) throw new Error("a readable answer was rejected");
    expect(scored.correct).toBe(true);
    expect(scored.replayed).toBe(false);
    const attempt = db
      .prepare(`SELECT estimator_evidence AS evidence, difficulty_step AS step FROM attempts WHERE id = ?`)
      .get(scored.attemptId) as { evidence: number; step: number };
    expect(attempt).toEqual({ evidence: 0, step: 1 });
    expect(evidenceForSkill(db, child.id, SKILLS.sub)).toHaveLength(0);
    const replay = submitAnswer(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "repeat-evidence-score",
        sessionId: session.sessionId,
        itemId: session.item.id,
        itemInstanceId: repeated.itemInstanceId,
        answer: repeated.canonicalAnswer,
        shownAt: new Date(Date.parse(submittedAt) - 2_000).toISOString(),
        submittedAt,
      },
      { now: submittedAt },
    );
    if (isFormatRejected(replay)) throw new Error("a readable answer was rejected");
    expect(replay.replayed).toBe(true);
    expect(evidenceForSkill(db, child.id, SKILLS.sub)).toHaveLength(0);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM attempts WHERE child_id = ?`).get(child.id) as { count: number }).count).toBe(1);
    expect(
      (db.prepare(`SELECT difficulty_step AS step FROM learner_progress WHERE child_id = ?`).get(child.id) as {
        step: number;
      }).step,
    ).toBe(0);
    expect(exhaustionEventCounts(db, child.id).some((row) => row.reason === "exhausted_repeat")).toBe(true);
  });

  it("switches to the next rotation skill and skips an exhausted one", () => {
    const db = tempDb();
    const { child, session } = granted(db, "next-skill@example.com");
    db.prepare(
      `UPDATE item_template_versions SET active = 0
       WHERE skill_id = ? AND template_id != 'frac-equiv-lowest'`,
    ).run(SKILLS.equiv);
    db.prepare(
      `UPDATE item_template_versions SET active = 0
       WHERE skill_id = ? AND template_id != 'frac-add-like-v0'`,
    ).run(SKILLS.addLike);
    const lowest = newestTemplate("frac-equiv-lowest");
    if (!lowest) throw new Error("missing lowest template");
    const pool = eligibleDraws(lowest, 1);
    expect(pool.length).toBeGreaterThan(0);
    for (let index = 0; index < pool.length; index += 1) {
      const issued = issueForProgression(db, {
        childId: child.id,
        sessionId: session.sessionId,
        skillId: SKILLS.equiv,
        idempotencyKey: `next-fill-${index}`,
        now: new Date(Date.parse(WHEN) + index * 1000).toISOString(),
      });
      expect(issued.issueReason).toBe("normal");
      expect(issued.templateId).toBe("frac-equiv-lowest");
    }
    const next = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "next-rotation-slot",
      now: new Date(Date.parse(WHEN) + pool.length * 1000).toISOString(),
    });
    expect(next.issueReason).toBe("exhausted_switch");
    expect(next.difficultyStep).toBe(assignedStepForSkill(SKILLS.addLike));
    expect(skillOfIssued(db, next.templateId, next.templateVersion)).toBe(SKILLS.addLike);
    expect(next.templateId).toBe("frac-add-like-v0");

    const skipped = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "next-rotation-skip",
      now: new Date(Date.parse(WHEN) + (pool.length + 1) * 1000).toISOString(),
    });
    expect(skipped.issueReason).toBe("exhausted_switch");
    expect(skipped.difficultyStep).toBe(assignedStepForSkill(SKILLS.addUnlike));
    const skippedSkill = skillOfIssued(db, skipped.templateId, skipped.templateVersion);
    expect(skippedSkill).toBe(SKILLS.addUnlike);
    expect(skippedSkill).not.toBe(SKILLS.add);
    expect(skippedSkill).not.toBe(SKILLS.addLike);
  });

  it("counts a switch when only the previous template still has fresh items", () => {
    const improper = newestTemplate("frac-equiv-improper");
    const mixed = newestTemplate("frac-equiv-mixed");
    if (!improper || !mixed) throw new Error("missing equivalent-fraction templates");
    const improperPool = eligibleDraws(improper, 1);
    const mixedPool = eligibleDraws(mixed, 1);
    expect(improperPool.length).toBeGreaterThan(mixedPool.length);
    expect(mixedPool.length).toBeGreaterThan(0);
    const db = tempDb();
    db.prepare(
      `UPDATE item_template_versions SET active = 0
       WHERE skill_id = ? AND template_id != 'frac-equiv-mixed'`,
    ).run(SKILLS.equiv);
    const { child, session } = granted(db);
    const opened = readItemInstance(db, session.item.itemInstanceId ?? "");
    if (!opened) throw new Error("session did not issue");
    let clock = Date.parse(opened.issuedAt);
    for (let index = 0; index < mixedPool.length; index += 1) {
      if (index > 0) {
        clock += 1000;
        issueForProgression(db, {
          childId: child.id,
          sessionId: session.sessionId,
          skillId: SKILLS.add,
          idempotencyKey: `improper-left-gap-${index}`,
          now: new Date(clock).toISOString(),
        });
      }
      clock += 1000;
      const issued = issueForProgression(db, {
        childId: child.id,
        sessionId: session.sessionId,
        skillId: SKILLS.equiv,
        idempotencyKey: `improper-left-mixed-${index}`,
        now: new Date(clock).toISOString(),
      });
      expect(issued.templateId).toBe("frac-equiv-mixed");
      expect(issued.issueReason).toBe("normal");
    }
    db.prepare(
      `UPDATE item_template_versions SET active = 1
       WHERE template_id = 'frac-equiv-improper'
         AND template_version = (
           SELECT MAX(template_version) FROM item_template_versions WHERE template_id = 'frac-equiv-improper'
         )`,
    ).run();
    const stillFresh = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "improper-left-one",
      now: new Date(clock + 1000).toISOString(),
    });
    expect(stillFresh.templateId).toBe("frac-equiv-improper");
    expect(stillFresh.issueReason).toBe("normal");
    expect(stillFresh.difficultyStep).toBe(1);
    const switched = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.equiv,
      idempotencyKey: "improper-left-switch",
      now: new Date(clock + 2000).toISOString(),
    });
    expect(switched.issueReason).toBe("template_switch");
    expect(switched.templateId).not.toBe("frac-equiv-improper");
    expect(skillOfIssued(db, switched.templateId, switched.templateVersion)).toBe(SKILLS.addLike);
    expect(switched.difficultyStep).toBe(assignedStepForSkill(SKILLS.addLike));
    const improperIssued = (
      db.prepare(`SELECT COUNT(*) AS count FROM item_instances WHERE child_id = ? AND template_id = 'frac-equiv-improper'`).get(child.id) as {
        count: number;
      }
    ).count;
    expect(improperIssued).toBe(1);
    expect(improperIssued).toBeLessThan(improperPool.length);
    expect(switched.requestedSkillId).toBe(SKILLS.equiv);
    const fallback = ITEM_CATALOG.find((item) => item.skill === SKILLS.equiv);
    if (!fallback) throw new Error("missing equivalent-fraction catalog item");
    const labeled = publicItemForInstance(db, switched, fallback);
    expect(labeled.skill).toBe(SKILLS.addLike);
    const route = readFileSync(
      path.join(process.cwd(), "app/api/children/[id]/sessions/[sessionId]/items/route.ts"),
      "utf8",
    );
    expect(route).toContain("publicItemForInstance");
    const rates = skillSwitchRates(db, child.id);
    expect(rates.find((row) => row.skill === SKILLS.equiv)?.templateSwitch).toBe(1);
    expect(rates.find((row) => row.skill === SKILLS.equiv)?.exhaustedSwitch).toBe(0);
    expect(rates.find((row) => row.skill === SKILLS.addLike)?.templateSwitch ?? 0).toBe(0);
    expect(rates.find((row) => row.skill === SKILLS.addLike)?.exhaustedSwitch ?? 0).toBe(0);
  });

  it("weights every template equally", () => {
    expect(DEFAULT_TEMPLATE_DRAW_WEIGHT).toBe(1);
    expect(TEMPLATE_DRAW_WEIGHTS).toEqual({});
  });

  it("breaks a never-issued template tie with the child id", () => {
    const firstTemplate = (childId: string, key: string) => {
      const db = tempDb();
      const guardian = createGuardian(db, {
        email: `${childId}@example.com`,
        password: "correct-horse",
        timezone: "America/Los_Angeles",
      });
      db.prepare(
        `INSERT INTO children (id, guardian_id, display_name, timezone, created_at)
         VALUES (?, ?, ?, 'America/Los_Angeles', ?)`,
      ).run(childId, guardian.id, childId, WHEN);
      openRotationSession(db, childId, `${childId}-session`, WHEN);
      const issued = issueForProgression(db, {
        childId,
        sessionId: `${childId}-session`,
        skillId: SKILLS.sub,
        idempotencyKey: key,
        now: new Date(Date.parse(WHEN) + 1000).toISOString(),
      });
      return issued.templateId;
    };
    const left = firstTemplate("tie-child", "tie-key-a");
    expect(firstTemplate("tie-child", "tie-key-b")).toBe(left);
    const others = ["tie-b", "tie-c", "tie-d", "tie-e", "tie-f", "tie-g", "tie-h"].map((id) =>
      firstTemplate(id, "tie-key-a"),
    );
    expect(others.some((templateId) => templateId !== left)).toBe(true);
  });

  it("flags a template above 60% of a skill's draws", () => {
    const db = tempDb();
    const inline = newestTemplate("sub-2d-inline");
    const blank = newestTemplate("sub-2d-blank");
    if (!inline || !blank) throw new Error("missing subtract templates");
    const insert = db.prepare(
      `INSERT INTO item_instances (
         item_instance_id, child_id, session_id, template_id, template_version, difficulty_step,
         operands_json, operand_key, canonical_answer, answer_line, prompt, presentation_json,
         evidence_eligible, repeat_forced, issue_reason, requested_skill_id, issue_idempotency_key,
         issued_at, compare_mode, bug_hits_json
       ) VALUES (
         ?, 'share-child', 'share-session', ?, ?, 1,
         '{}', ?, '1', '1', '1 + 1', '{}',
         1, 0, 'normal', ?, ?, ?, 'exact', '[]'
       )`,
    );
    for (let index = 0; index < 7; index += 1) {
      insert.run(
        `share-inline-${index}`,
        inline.templateId,
        inline.version,
        `inline-${index}`,
        SKILLS.sub,
        `share-inline-key-${index}`,
        new Date(Date.parse(WHEN) + index * 1000).toISOString(),
      );
    }
    for (let index = 0; index < 3; index += 1) {
      insert.run(
        `share-blank-${index}`,
        blank.templateId,
        blank.version,
        `blank-${index}`,
        SKILLS.sub,
        `share-blank-key-${index}`,
        new Date(Date.parse(WHEN) + (index + 7) * 1000).toISOString(),
      );
    }
    const pools = poolIssuanceCounts(db, "share-child");
    const heavy = pools.find((pool) => pool.templateId === inline.templateId);
    const light = pools.find((pool) => pool.templateId === blank.templateId);
    expect(heavy?.share).toBe(0.7);
    expect(heavy?.aboveShareCap).toBe(true);
    expect(light?.share).toBe(0.3);
    expect(light?.aboveShareCap).toBe(false);
    expect(TEMPLATE_SHARE_CAP).toBe(0.6);
  });

  it("skips a spent 1-item subtract template without a switch or a repeat", () => {
    const db = tempDb();
    const { child, session } = granted(db, "sub-seed-skip@example.com");
    const issued: ItemInstance[] = [];
    for (let index = 0; index < 8; index += 1) {
      issued.push(
        issueForProgression(db, {
          childId: child.id,
          sessionId: session.sessionId,
          skillId: SKILLS.sub,
          idempotencyKey: `sub-seed-${index}`,
          now: new Date(Date.parse(WHEN) + index * 1000).toISOString(),
        }),
      );
    }
    const seedAt = issued.findIndex((row) => row.templateId === "sub-2d-v0");
    expect(seedAt).toBeGreaterThanOrEqual(0);
    expect(seedAt).toBeLessThan(4);
    const next = issued[seedAt + 1];
    if (!next) throw new Error("no draw after the 1-item subtract template");
    expect(next.templateId).not.toBe("sub-2d-v0");
    expect(next.issueReason).toBe("normal");
    expect(skillOfIssued(db, next.templateId, next.templateVersion)).toBe(SKILLS.sub);
    expect(issued.filter((row) => row.templateId === "sub-2d-v0")).toHaveLength(1);
    expect(issued.every((row) => row.issueReason === "normal" && row.repeatForced === false)).toBe(true);
    const reasons = db
      .prepare(
        `SELECT issue_reason AS reason, COUNT(*) AS count
         FROM item_instances
         WHERE child_id = ? AND requested_skill_id = ?
         GROUP BY issue_reason`,
      )
      .all(child.id, SKILLS.sub) as Array<{ reason: string; count: number }>;
    expect(reasons).toEqual([{ reason: "normal", count: 8 }]);
  });

  it("picks the least recently seen template from the issued log", () => {
    const db = tempDb();
    const { child, session } = granted(db, "seen-log@example.com");
    const opened = readItemInstance(db, session.item.itemInstanceId ?? "");
    if (!opened) throw new Error("session did not issue");
    const issued: ItemInstance[] = [];
    for (let index = 0; index < 5; index += 1) {
      issued.push(
        issueForProgression(db, {
          childId: child.id,
          sessionId: session.sessionId,
          skillId: SKILLS.sub,
          idempotencyKey: `seen-log-${index}`,
          now: new Date(Date.parse(opened.issuedAt) + (index + 1) * 1000).toISOString(),
        }),
      );
    }
    expect(issued.every((row) => row.issueReason === "normal")).toBe(true);
    const firstFour = issued.slice(0, 4);
    expect(new Set(firstFour.map((row) => row.templateId)).size).toBe(4);
    const oldestFresh = firstFour
      .filter((row) => row.templateId !== "sub-2d-v0")
      .reduce((best, row) => (row.issuedAt < best.issuedAt ? row : best));
    expect(issued[4]?.templateId).toBe(oldestFresh.templateId);
  });

  it("records template_switch when the only fresh template is the one just used", () => {
    const inline = newestTemplate("sub-2d-inline");
    if (!inline) throw new Error("missing subtract inline template");
    expect(eligibleDraws(inline, 1).length).toBeGreaterThan(1);
    const db = tempDb();
    db.prepare(
      `UPDATE item_template_versions SET active = 0
       WHERE skill_id = ? AND template_id != 'sub-2d-inline'`,
    ).run(SKILLS.sub);
    const { child, session } = granted(db, "template-switch@example.com");
    const opened = readItemInstance(db, session.item.itemInstanceId ?? "");
    if (!opened) throw new Error("session did not issue");
    const start = Date.parse(opened.issuedAt);
    const first = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.sub,
      idempotencyKey: "template-switch-first",
      now: new Date(start + 1000).toISOString(),
    });
    expect(first.issueReason).toBe("normal");
    expect(first.templateId).toBe("sub-2d-inline");
    const switched = issueForProgression(db, {
      childId: child.id,
      sessionId: session.sessionId,
      skillId: SKILLS.sub,
      idempotencyKey: "template-switch-next",
      now: new Date(start + 2000).toISOString(),
    });
    expect(switched.issueReason).toBe("template_switch");
    expect(switched.evidenceEligible).toBe(true);
    expect(switched.repeatForced).toBe(false);
    expect(switched.requestedSkillId).toBe(SKILLS.sub);
    expect(skillOfIssued(db, switched.templateId, switched.templateVersion)).not.toBe(SKILLS.sub);
    const stillFresh = (
      db.prepare(`SELECT COUNT(*) AS count FROM item_instances WHERE child_id = ? AND template_id = 'sub-2d-inline'`).get(child.id) as {
        count: number;
      }
    ).count;
    expect(stillFresh).toBe(1);
    expect(stillFresh).toBeLessThan(eligibleDraws(inline, 1).length);
  });

  it("issues every fresh template before repeating one", () => {
    const db = tempDb();
    const { child, session } = granted(db, "round-robin@example.com");
    const seen = new Set<string>();
    for (let index = 0; index < 4; index += 1) {
      const issued = issueForProgression(db, {
        childId: child.id,
        sessionId: session.sessionId,
        skillId: SKILLS.sub,
        idempotencyKey: `round-robin-sub-${index}`,
        now: new Date(Date.parse(WHEN) + index * 1000).toISOString(),
      });
      expect(issued.issueReason, issued.templateId).toBe("normal");
      expect(seen.has(issued.templateId), issued.templateId).toBe(false);
      seen.add(issued.templateId);
    }
    expect(seen.size).toBe(4);
  });

  it("gives a 7-day dogfood run zero exact repeats", () => {
    // Simulation (a): 15 items per session, one session a day, for 7 days.
    // Skills follow the current 11-slot catalog rotation.
    const itemsPerSession = 15;
    const days = 7;
    const db = tempDb();
    const { guardian, child, session } = granted(db);
    const opened = readItemInstance(db, session.item.itemInstanceId ?? "");
    if (!opened) throw new Error("session did not issue");
    const rotation = issueRotationWeek(db, child.id, Date.parse(opened.issuedAt), {
      sessionsPerDay: 1,
      itemsPerSession,
      days,
      keyPrefix: "dogfood",
    });
    const stamp = rotation.stamp;
    const maxSwitches = assertAtMostOneSwitch(rotation.sessions);
    expect(maxSwitches).toBeLessThanOrEqual(1);
    const distinct = assertDistinctTemplates(db, child.id);
    expect(distinct.every((row) => row.templates >= MIN_DISTINCT_TEMPLATES)).toBe(true);
    expect(ITEM_CATALOG).toHaveLength(11);
    const rows = db
      .prepare(
        `SELECT template_id AS templateId, operand_key AS operandKey, issue_reason AS issueReason, repeat_forced AS repeatForced
         FROM item_instances WHERE child_id = ?`,
      )
      .all(child.id) as Array<{
      templateId: string;
      operandKey: string;
      issueReason: string;
      repeatForced: number;
    }>;
    const keys = rows.map((row) => `${row.templateId}:${row.operandKey}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows.every((row) => row.repeatForced === 0)).toBe(true);
    expect(repeatPoolReport(db, child.id), repeatPoolReport(db, child.id).join("; ")).toEqual([]);
    const rates = assertRotationLimits(db, child.id);
    expect(rates.every((row) => row.rate <= MAX_SKILL_SWITCH_RATE)).toBe(true);
    const end = new Date(stamp).toISOString();
    expect(exactRepeatRate(db, child.id, end).forced).toBe(0);
    const pools = poolIssuanceCounts(db, child.id);
    expect(pools.reduce((sum, row) => sum + row.issued, 0)).toBe(rows.length);
    const skillIssued = new Map<string, number>();
    const templateIssued = new Map<string, number>();
    for (const pool of pools) {
      skillIssued.set(pool.skill, (skillIssued.get(pool.skill) ?? 0) + pool.issued);
      const key = `${pool.skill}\0${pool.templateId}`;
      templateIssued.set(key, (templateIssued.get(key) ?? 0) + pool.issued);
    }
    for (const pool of pools) {
      expect(pool.exhaustedRepeat).toBe(0);
      expect(pool.switchRate).toBe(
        pool.issued === 0 ? 0 : (pool.templateSwitch + pool.exhaustedSwitch) / pool.issued,
      );
      const total = skillIssued.get(pool.skill) ?? 0;
      const templateTotal = templateIssued.get(`${pool.skill}\0${pool.templateId}`) ?? 0;
      expect(pool.share).toBe(total === 0 ? 0 : templateTotal / total);
      expect(pool.aboveShareCap).toBe(pool.share > TEMPLATE_SHARE_CAP);
    }
    const home = getChildHome(db, guardian.id, child.id);
    const summary = readParentSummary(db, guardian.id, child.id, end);
    expect(JSON.stringify({ home, summary, pools: "hidden" })).not.toMatch(
      /switchRate|poolIssuance|exhaustedSwitch|exhaustedRepeat/,
    );
    const surfaceFiles = [
      "app/parent/page.tsx",
      "app/api/children/[id]/parent-summary/route.ts",
      "app/api/children/[id]/home/route.ts",
      "lib/parent-summary.ts",
      "components/parent-one-breath.tsx",
      "components/practice-problem.tsx",
      "components/practice-session.tsx",
    ];
    for (const file of surfaceFiles) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/poolIssuanceCounts|exhaustionEventCounts|switchRate/);
    }
  });

  it("gives a heavy rotation week zero repeats and a switch rate of at most 10%", () => {
    // Simulation (c): 2 sessions of 15 items a day, for 7 days, on the 11-slot rotation.
    const sessionsPerDay = 2;
    const itemsPerSession = 15;
    const days = 7;
    const db = tempDb();
    const { child, session } = granted(db, "heavy-rotation@example.com");
    const opened = readItemInstance(db, session.item.itemInstanceId ?? "");
    if (!opened) throw new Error("session did not issue");
    const rotation = issueRotationWeek(db, child.id, Date.parse(opened.issuedAt), {
      sessionsPerDay,
      itemsPerSession,
      days,
      keyPrefix: "heavy-rot",
    });
    const maxSwitches = assertAtMostOneSwitch(rotation.sessions);
    expect(maxSwitches).toBeLessThanOrEqual(1);
    const distinct = assertDistinctTemplates(db, child.id);
    expect(distinct.every((row) => row.templates >= MIN_DISTINCT_TEMPLATES)).toBe(true);
    expect(ITEM_CATALOG).toHaveLength(11);
    const rates = assertRotationLimits(db, child.id);
    expect(rates.every((row) => row.rate <= MAX_SKILL_SWITCH_RATE)).toBe(true);
    expect(repeatPoolReport(db, child.id)).toEqual([]);
  }, 30_000);

  it("gives 20 children a one-session week under the template floor", () => {
    // 1 session of 15 items a day for 7 days. Child ids are fixed and distinct.
    // There is no session opener. Round-robin must clear 3 templates for every child.
    const db = tempDb();
    const result = runChildCohort(db, "cohort-once@example.com", {
      childPrefix: "once",
      sessionsPerDay: 1,
    });
    assertCohortLimits(result);
    for (const rows of result.perChild) {
      const compare = rows.find((row) => row.skill === SKILLS.compare);
      expect(compare).toMatchObject({ issued: 9, templateSwitch: 0, exhaustedSwitch: 0 });
    }
    expect(
      result.summary.filter(
        (row) => row.overall !== 0 || row.worst !== 0 || row.templateSwitch !== 0 || row.exhaustedSwitch !== 0,
      ),
    ).toEqual([]);
  }, 120_000);

  it("gives 20 children a heavy rotation week under the switch cap", () => {
    // 2 sessions of 15 items a day for 7 days. Child ids are fixed and distinct.
    // There is no session opener.
    const db = tempDb();
    const result = runChildCohort(db, "cohort@example.com", {
      childPrefix: "cohort",
      sessionsPerDay: 2,
    });
    assertCohortLimits(result);
    for (const rows of result.perChild) {
      const compare = rows.find((row) => row.skill === SKILLS.compare);
      expect(compare).toMatchObject({ issued: 19, templateSwitch: 0, exhaustedSwitch: 0 });
    }
    expect(
      result.summary.filter(
        (row) => row.overall !== 0 || row.worst !== 0 || row.templateSwitch !== 0 || row.exhaustedSwitch !== 0,
      ),
    ).toEqual([]);
  }, 120_000);

  it("gives every pool a heavy week with zero exhausted repeats", () => {
    // Simulation (b): 2 sessions of 15 items a day, for 7 days.
    // Each skill is its own pool, including allowlisted ones. A repeat names that pool.
    const sessionsPerDay = 2;
    const itemsPerSession = 15;
    const days = 7;
    const total = sessionsPerDay * itemsPerSession * days;
    const db = tempDb();
    const failures: string[] = [];
    for (const item of ITEM_CATALOG) {
      const { child, session } = granted(db, `${item.id}@example.com`);
      const opened = readItemInstance(db, session.item.itemInstanceId ?? "");
      if (!opened) throw new Error("session did not issue");
      let stamp = Date.parse(opened.issuedAt);
      for (let index = 0; index < total; index += 1) {
        stamp += 1000;
        const issued = issueForProgression(db, {
          childId: child.id,
          sessionId: session.sessionId,
          skillId: item.skill,
          idempotencyKey: `pool-${item.id}-${index}`,
          now: new Date(stamp).toISOString(),
        });
        expect(issued.difficultyStep, item.skill).toBe(1);
        expect(issued.repeatForced, item.skill).toBe(false);
      }
      const repeats = repeatPoolReport(db, child.id);
      if (repeats.length > 0) failures.push(...repeats);
      const rows = db
        .prepare(
          `SELECT template_id AS templateId, operand_key AS operandKey
           FROM item_instances WHERE child_id = ?`,
        )
        .all(child.id) as Array<{ templateId: string; operandKey: string }>;
      const keys = rows.map((row) => `${row.templateId}:${row.operandKey}`);
      if (new Set(keys).size !== keys.length) failures.push(`${item.skill}: exact repeat`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
    expect(ITEM_CATALOG).toHaveLength(11);
  }, 60_000);

  it("defaults an older item instance to issue_reason normal", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE item_instances (
        item_instance_id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        template_version INTEGER NOT NULL,
        difficulty_step INTEGER NOT NULL,
        operands_json TEXT NOT NULL,
        operand_key TEXT NOT NULL,
        canonical_answer TEXT NOT NULL,
        answer_line TEXT NOT NULL,
        prompt TEXT NOT NULL,
        presentation_json TEXT NOT NULL,
        evidence_eligible INTEGER NOT NULL,
        repeat_forced INTEGER NOT NULL,
        issue_idempotency_key TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_by_attempt_key TEXT,
        require_form TEXT,
        compare_mode TEXT NOT NULL,
        bug_hits_json TEXT NOT NULL,
        default_focus TEXT,
        why_it_works TEXT
      );
      INSERT INTO item_instances (
        item_instance_id, child_id, session_id, template_id, template_version, difficulty_step,
        operands_json, operand_key, canonical_answer, answer_line, prompt, presentation_json,
        evidence_eligible, repeat_forced, issue_idempotency_key, issued_at, compare_mode, bug_hits_json
      ) VALUES (
        'old-instance', 'child-1', 'session-1', 'add-2d-v0', 0, 1,
        '{}', 'a=1', '2', '2', '1 + 1', '{}',
        1, 0, 'old-issue-key', '2026-06-01T00:00:00.000Z', 'exact', '[]'
      );
    `);
    migrateItemTemplates(db);
    const row = db.prepare(`SELECT issue_reason FROM item_instances WHERE item_instance_id = ?`).get("old-instance") as {
      issue_reason: string;
    };
    expect(row.issue_reason).toBe("normal");
    const requested = db
      .prepare(`SELECT requested_skill_id AS skill FROM item_instances WHERE item_instance_id = ?`)
      .get("old-instance") as { skill: string | null };
    expect(requested.skill).toBeNull();
    db.close();
  });

  it("stores template_switch on a database created before that reason", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE item_instances (
        item_instance_id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        template_version INTEGER NOT NULL,
        difficulty_step INTEGER NOT NULL,
        operands_json TEXT NOT NULL,
        operand_key TEXT NOT NULL,
        canonical_answer TEXT NOT NULL,
        answer_line TEXT NOT NULL,
        prompt TEXT NOT NULL,
        presentation_json TEXT NOT NULL,
        evidence_eligible INTEGER NOT NULL,
        repeat_forced INTEGER NOT NULL,
        issue_reason TEXT NOT NULL DEFAULT 'normal' CHECK (
          issue_reason IN ('normal', 'exhausted_switch', 'exhausted_repeat')
        ),
        requested_skill_id TEXT,
        issue_idempotency_key TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_by_attempt_key TEXT,
        require_form TEXT,
        compare_mode TEXT NOT NULL,
        bug_hits_json TEXT NOT NULL,
        default_focus TEXT,
        why_it_works TEXT,
        UNIQUE (session_id, issue_idempotency_key)
      );
      INSERT INTO item_instances (
        item_instance_id, child_id, session_id, template_id, template_version, difficulty_step,
        operands_json, operand_key, canonical_answer, answer_line, prompt, presentation_json,
        evidence_eligible, repeat_forced, issue_reason, issue_idempotency_key, issued_at, compare_mode, bug_hits_json
      ) VALUES (
        'old-reason', 'child-1', 'session-1', 'add-2d-v0', 0, 1,
        '{}', 'a=1', '2', '2', '1 + 1', '{}',
        1, 0, 'normal', 'old-reason-key', '2026-06-01T00:00:00.000Z', 'exact', '[]'
      );
    `);
    migrateItemTemplates(db);
    db.prepare(
      `INSERT INTO item_instances (
         item_instance_id, child_id, session_id, template_id, template_version, difficulty_step,
         operands_json, operand_key, canonical_answer, answer_line, prompt, presentation_json,
         evidence_eligible, repeat_forced, issue_reason, issue_idempotency_key, issued_at, compare_mode, bug_hits_json
       ) VALUES (
         'new-reason', 'child-1', 'session-1', 'add-2d-inline', 1, 1,
         '{}', 'a=2', '3', '3', '1 + 2', '{}',
         1, 0, 'template_switch', 'new-reason-key', '2026-06-01T00:00:01.000Z', 'exact', '[]'
       )`,
    ).run();
    const reasons = db
      .prepare(`SELECT item_instance_id AS id, issue_reason AS reason FROM item_instances ORDER BY issued_at`)
      .all() as Array<{ id: string; reason: string }>;
    expect(reasons).toEqual([
      { id: "old-reason", reason: "normal" },
      { id: "new-reason", reason: "template_switch" },
    ]);
    db.close();
  });
});

function syncedAttempt(idempotencyKey: string): AttemptResult {
  return {
    whatWentWell: "",
    oneFocus: "",
    tryNext: "",
    lockIn: "",
    attemptId: `attempt-${idempotencyKey}`,
    idempotencyKey,
    replayed: false,
    correct: true,
    celebrationTier: "none",
    lane: "celebrate",
    flags: [],
    eventIds: [],
    xpAmount: 0,
    fuel: { credit: 0, heatEventId: null, pieceEventIds: [] },
    clientView: { bandLabel: "Still learning", showConceptChip: false, celebrationTier: "none" },
    nextItem: { id: "ops-g2-add", pack: "operations", grade: 2, skill: "add", prompt: "1 + 1" },
  };
}
