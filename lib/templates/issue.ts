import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { PublicItem } from "@/lib/attempt-contract";
import { DomainError } from "@/lib/domain";
import { ITEM_CATALOG, itemAt } from "@/lib/item-catalog";
import { answersMatch, canonicalValueKey, type RequireForm } from "@/lib/templates/rational";
import { eligibleDraws, seeded, type Rng } from "@/lib/templates/engine";
import {
  issuanceTemplateSelect,
  parseIssuanceTemplate,
  type IssuanceTemplateRow,
} from "@/lib/templates/store";
import type { BugHit, TemplateVersion } from "@/lib/templates/types";
import { cueText, tryNextFromCue } from "@/lib/templates/cues";
import { answerKindForTemplate, formatExampleFor } from "@/lib/templates/format-example";
import type { AnswerKind } from "@/lib/unparseable";

/** Progression stays rules-v0 and assigns difficulty step 1. */
export const PROGRESSION_DIFFICULTY_STEP = 1 as const;

export type IssueReason = "normal" | "template_switch" | "exhausted_switch" | "exhausted_repeat";

/**
 * The step this skill is assigned right now.
 * Issuance reads it and must not write learner state or this assignment.
 */
export function assignedStepForSkill(_skillId: string): 1 | 2 | 3 {
  return PROGRESSION_DIFFICULTY_STEP;
}
export const REPEAT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const ISSUE_BATCH_CAP = 3;

/**
 * Unanswered instances one session may hold, including the item on screen.
 * A fresh batch key stops at this cap so it cannot drain the 7-day pool
 * or leave the current item behind.
 */
export const OUTSTANDING_UNANSWERED_CAP = 3;

/**
 * Relative draw weight of one template. Ids omitted here use
 * `DEFAULT_TEMPLATE_DRAW_WEIGHT`. The default is equal weight, which is pure
 * least-recently-seen. There is no weighted draw and no share floor. A map
 * entry that is not the default is rejected.
 */
export const DEFAULT_TEMPLATE_DRAW_WEIGHT = 1;
export const TEMPLATE_DRAW_WEIGHTS: Readonly<Record<string, number>> = {};

export type StepWord = "Warm-up" | "Steady" | "Stretch";

export type ItemPresentation = {
  layout: "inline" | "column";
  blank: string;
  leading: string;
  trailing: string;
  column: string[];
  stepWord: StepWord;
};

export type ItemInstance = {
  itemInstanceId: string;
  childId: string;
  sessionId: string;
  templateId: string;
  templateVersion: number;
  difficultyStep: number;
  operands: Record<string, number>;
  operandKey: string;
  canonicalAnswer: string;
  answerLine: string;
  prompt: string;
  presentation: ItemPresentation;
  evidenceEligible: boolean;
  repeatForced: boolean;
  /** Why this row was issued. Never copied onto the child payload. */
  issueReason: IssueReason;
  /** Skill the child was asking for. A switch is credited here, not to the template skill. */
  requestedSkillId: string | null;
  issueIdempotencyKey: string;
  issuedAt: string;
  consumedAt: string | null;
  consumedByAttemptKey: string | null;
  requireForm: RequireForm | null;
  compareMode: "rational" | "exact";
  bugHits: BugHit[];
  defaultFocus: string | null;
  whyItWorks: string | null;
  /** From the template family, not from this draw's canonical answer. */
  answerKind: AnswerKind;
};

type InstanceRow = {
  item_instance_id: string;
  child_id: string;
  session_id: string;
  template_id: string;
  template_version: number;
  difficulty_step: number;
  operands_json: string;
  operand_key: string;
  canonical_answer: string;
  answer_line: string;
  prompt: string;
  presentation_json: string;
  evidence_eligible: number;
  repeat_forced: number;
  issue_reason: IssueReason;
  requested_skill_id: string | null;
  issue_idempotency_key: string;
  issued_at: string;
  consumed_at: string | null;
  consumed_by_attempt_key: string | null;
  require_form: RequireForm | null;
  compare_mode: "rational" | "exact";
  bug_hits_json: string;
  default_focus: string | null;
  why_it_works: string | null;
};

export type Exposure = {
  templateId: string;
  operandKey: string;
  lastAt: string;
};

export function stepWord(step: number): StepWord {
  if (step === 2) return "Steady";
  if (step === 3) return "Stretch";
  return "Warm-up";
}

export function sessionSlotKey(sessionId: string, itemIndex: number): string {
  return `sess:${sessionId}:idx:${itemIndex}`;
}

export function operandKey(operands: Record<string, number>, canonicalAnswer: string): string {
  const body = Object.keys(operands)
    .sort()
    .map((key) => `${key}=${operands[key]}`)
    .join(",");
  return `${body}=>${canonicalAnswer.replace(/\s+/g, "")}`;
}

/** Oldest last exposure wins. Template id, then operand key, breaks ties. */
export function pickOldestExposure(rows: readonly Exposure[]): Exposure | null {
  if (rows.length === 0) return null;
  return [...rows].sort((left, right) => {
    if (left.lastAt !== right.lastAt) return left.lastAt < right.lastAt ? -1 : 1;
    if (left.templateId !== right.templateId) return left.templateId < right.templateId ? -1 : 1;
    if (left.operandKey !== right.operandKey) return left.operandKey < right.operandKey ? -1 : 1;
    return 0;
  })[0] ?? null;
}

/**
 * Step variants issuance will draw. The only input is assigned_step.
 * Parent prior is not an argument.
 */
export function variantsForAssignedStep(template: TemplateVersion, step: 1 | 2 | 3) {
  return template.spec.steps.filter((variant) => variant.assignedStep === step);
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function templateFamily(
  db: Database.Database,
  templateId: string,
  templateVersion: number,
): string {
  const row = db
    .prepare(
      `SELECT spec_json FROM item_template_versions
       WHERE template_id = ? AND template_version = ?`,
    )
    .get(templateId, templateVersion) as { spec_json: string } | undefined;
  if (!row) throw new DomainError("That problem is not in this practice pack.", 404);
  const spec = JSON.parse(row.spec_json) as { family?: string };
  if (!spec.family) throw new DomainError("That problem is not in this practice pack.", 404);
  return spec.family;
}

function mapInstance(db: Database.Database, row: InstanceRow): ItemInstance {
  return {
    itemInstanceId: row.item_instance_id,
    childId: row.child_id,
    sessionId: row.session_id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    difficultyStep: row.difficulty_step,
    operands: JSON.parse(row.operands_json) as Record<string, number>,
    operandKey: row.operand_key,
    canonicalAnswer: row.canonical_answer,
    answerLine: row.answer_line,
    prompt: row.prompt,
    presentation: JSON.parse(row.presentation_json) as ItemPresentation,
    evidenceEligible: row.evidence_eligible === 1,
    repeatForced: row.repeat_forced === 1,
    issueReason: row.issue_reason,
    requestedSkillId: row.requested_skill_id,
    issueIdempotencyKey: row.issue_idempotency_key,
    issuedAt: row.issued_at,
    consumedAt: row.consumed_at,
    consumedByAttemptKey: row.consumed_by_attempt_key,
    requireForm: row.require_form,
    compareMode: row.compare_mode,
    bugHits: JSON.parse(row.bug_hits_json) as BugHit[],
    defaultFocus: row.default_focus,
    whyItWorks: row.why_it_works,
    answerKind: answerKindForTemplate(templateFamily(db, row.template_id, row.template_version)),
  };
}

const INSTANCE_SELECT = `SELECT item_instance_id, child_id, session_id, template_id, template_version,
  difficulty_step, operands_json, operand_key, canonical_answer, answer_line, prompt,
  presentation_json, evidence_eligible, repeat_forced, issue_reason, requested_skill_id,
  issue_idempotency_key, issued_at,
  consumed_at, consumed_by_attempt_key, require_form, compare_mode, bug_hits_json,
  default_focus, why_it_works
  FROM item_instances`;

export function readItemInstance(
  db: Database.Database,
  itemInstanceId: string,
): ItemInstance | null {
  const row = db
    .prepare(`${INSTANCE_SELECT} WHERE item_instance_id = ?`)
    .get(itemInstanceId) as InstanceRow | undefined;
  return row ? mapInstance(db, row) : null;
}

function readByIdempotency(
  db: Database.Database,
  sessionId: string,
  idempotencyKey: string,
): ItemInstance | null {
  const row = db
    .prepare(`${INSTANCE_SELECT} WHERE session_id = ? AND issue_idempotency_key = ?`)
    .get(sessionId, idempotencyKey) as InstanceRow | undefined;
  return row ? mapInstance(db, row) : null;
}

/** Child payload for an issued instance. The skill is the instance's, with the slot as a fallback. */
export function publicItemForInstance(
  db: Database.Database,
  instance: ItemInstance,
  fallback: PublicItem,
): PublicItem {
  const skillId = templateSkillId(db, instance.templateId, instance.templateVersion);
  const shown = ITEM_CATALOG.find((item) => item.skill === skillId) ?? fallback;
  return toPublicItem(shown, instance);
}

export function toPublicItem(catalog: PublicItem, instance: ItemInstance): PublicItem {
  const inline =
    instance.presentation.leading.length > 0 || instance.presentation.trailing.length > 0;
  const example = formatExampleFor(instance.answerKind, instance.canonicalAnswer);
  return {
    id: catalog.id,
    pack: catalog.pack,
    grade: catalog.grade,
    skill: catalog.skill,
    prompt: instance.prompt,
    stepWord: instance.presentation.stepWord,
    itemInstanceId: instance.itemInstanceId,
    answerKind: example.answerKind,
    formatExample: example.formatExample,
    layout: instance.presentation.layout,
    ...(inline
      ? {
          blankInline: {
            leading: instance.presentation.leading,
            trailing: instance.presentation.trailing,
          },
        }
      : {}),
    ...(instance.presentation.column.length > 0
      ? { columnLines: instance.presentation.column }
      : {}),
  };
}

function templateSkillId(
  db: Database.Database,
  templateId: string,
  templateVersion: number,
): string | null {
  const row = db
    .prepare(
      `SELECT skill_id FROM item_template_versions
       WHERE template_id = ? AND template_version = ?`,
    )
    .get(templateId, templateVersion) as { skill_id: string } | undefined;
  return row?.skill_id ?? null;
}

export function presentIssuedItem(
  db: Database.Database,
  childId: string,
  sessionId: string,
  itemIndex: number,
  now?: string,
): PublicItem {
  const catalog = itemAt(itemIndex);
  const instance = issueForProgression(db, {
    childId,
    sessionId,
    skillId: catalog.skill,
    idempotencyKey: sessionSlotKey(sessionId, itemIndex),
    now,
  });
  return publicItemForInstance(db, instance, catalog);
}

type ActiveTemplate = {
  template: TemplateVersion;
  evidenceEligible: boolean;
};

function loadActiveTemplates(
  db: Database.Database,
  skillId: string,
  step: 1 | 2 | 3,
): ActiveTemplate[] {
  const sql = `SELECT ${issuanceTemplateSelect()} FROM item_template_versions WHERE skill_id = ? AND active = 1`;
  if (sql.includes("parent_prior")) {
    throw new DomainError("Issuance tried to read parent prior.", 500);
  }
  const rows = db.prepare(sql).all(skillId) as IssuanceTemplateRow[];
  const newest = new Map<string, IssuanceTemplateRow>();
  for (const row of rows) {
    const current = newest.get(row.template_id);
    if (!current || row.template_version > current.template_version) newest.set(row.template_id, row);
  }
  const ready: ActiveTemplate[] = [];
  for (const row of newest.values()) {
    const template = parseIssuanceTemplate(row);
    if (variantsForAssignedStep(template, step).length === 0) continue;
    ready.push({ template, evidenceEligible: row.evidence_eligible === 1 });
  }
  ready.sort((left, right) => (left.template.templateId < right.template.templateId ? -1 : 1));
  return ready;
}

function issuedOperandKeys(
  db: Database.Database,
  childId: string,
  templateIds: readonly string[],
  since: string,
): Set<string> {
  if (templateIds.length === 0) return new Set();
  const placeholders = templateIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT template_id AS templateId, operand_key AS operandKey
       FROM item_instances
       WHERE child_id = ? AND issued_at >= ? AND template_id IN (${placeholders})`,
    )
    .all(childId, since, ...templateIds) as Array<{ templateId: string; operandKey: string }>;
  return new Set(rows.map((row) => `${row.templateId}\0${row.operandKey}`));
}

/**
 * Latest template issued to this child for this skill. Seen time is
 * `issued_at` on `item_instances`. Another skill's latest template does not
 * count. There is no per-child template counter.
 */
function lastSeenTemplateId(
  db: Database.Database,
  childId: string,
  skillId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT i.template_id AS templateId
       FROM item_instances i
       JOIN item_template_versions t
         ON t.template_id = i.template_id AND t.template_version = i.template_version
       WHERE i.child_id = ? AND t.skill_id = ?
       ORDER BY i.issued_at DESC, i.rowid DESC
       LIMIT 1`,
    )
    .get(childId, skillId) as { templateId: string } | undefined;
  return row?.templateId ?? null;
}

/** Oldest `issued_at` per template, from the same issued-instance log. */
function lastIssuedAtByTemplate(
  db: Database.Database,
  childId: string,
  templateIds: readonly string[],
): Map<string, string> {
  if (templateIds.length === 0) return new Map();
  const placeholders = templateIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT template_id AS templateId, MAX(issued_at) AS lastAt
       FROM item_instances
       WHERE child_id = ? AND template_id IN (${placeholders})
       GROUP BY template_id`,
    )
    .all(childId, ...templateIds) as Array<{ templateId: string; lastAt: string }>;
  return new Map(rows.map((row) => [row.templateId, row.lastAt]));
}

type FrozenDraw = {
  templateId: string;
  templateVersion: number;
  evidenceEligible: boolean;
  operands: Record<string, number>;
  canonicalAnswer: string;
  answerLine: string;
  prompt: string;
  presentation: ItemPresentation;
  bugHits: BugHit[];
  repeatForced: boolean;
  requireForm: RequireForm | null;
  compareMode: "rational" | "exact";
  defaultFocus: string | null;
  whyItWorks: string | null;
};

function presentationFor(template: TemplateVersion, draw: {
  leading: string;
  trailing: string;
  column: string[];
}, step: number): ItemPresentation {
  return {
    layout: template.spec.layout,
    blank: template.spec.blank,
    leading: draw.leading,
    trailing: draw.trailing,
    column: draw.column,
    stepWord: stepWord(step),
  };
}

const eligibleCache = new Map<string, ReturnType<typeof eligibleDraws>>();

function cachedEligibleDraws(template: TemplateVersion, step: 1 | 2 | 3) {
  const key = `${template.templateId}@${template.version}:${step}`;
  const hit = eligibleCache.get(key);
  if (hit) return hit;
  const draws = eligibleDraws(template, step);
  eligibleCache.set(key, draws);
  return draws;
}

function shuffleWith<T>(items: readonly T[], rng: Rng): T[] {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const current = copy[index];
    copy[index] = copy[swap] as T;
    copy[swap] = current as T;
  }
  return copy;
}

function assertEqualTemplateWeight(templateId: string): void {
  const weight = TEMPLATE_DRAW_WEIGHTS[templateId] ?? DEFAULT_TEMPLATE_DRAW_WEIGHT;
  if (weight !== DEFAULT_TEMPLATE_DRAW_WEIGHT) {
    throw new DomainError(`Template draw weight is equal only: ${templateId}`, 500);
  }
}

/**
 * Equal weight picks the least-recently seen template. Never-issued templates
 * come first. Templates with the same seen time are shuffled with a seed of
 * the child and the skill. The issue key does not break that tie.
 */
function pickFreshTemplate<T extends { choice: ActiveTemplate }>(
  fresh: readonly T[],
  lastAt: ReadonlyMap<string, string>,
  childId: string,
  skillId: string,
): T | undefined {
  for (const item of fresh) assertEqualTemplateWeight(item.choice.template.templateId);
  const rng = seeded(hashSeed(`${childId}:${skillId}`));
  const neverIssued = fresh.filter((item) => !lastAt.has(item.choice.template.templateId));
  const oldestAt =
    neverIssued.length > 0
      ? null
      : fresh.reduce((best, candidate) => {
          const bestAt = lastAt.get(best.choice.template.templateId) ?? "";
          const candidateAt = lastAt.get(candidate.choice.template.templateId) ?? "";
          return candidateAt < bestAt ? candidate : best;
        });
  const tied =
    oldestAt === null
      ? neverIssued
      : fresh.filter(
          (item) =>
            lastAt.get(item.choice.template.templateId) === lastAt.get(oldestAt.choice.template.templateId),
        );
  return shuffleWith(tied, rng)[0];
}

type SkillDraw =
  | { status: "drawn"; draw: FrozenDraw }
  | { status: "template_switch" }
  | { status: "exhausted" };

/**
 * (b) Least-recently-seen template that still has an unseen item, excluding
 * the template last issued for this skill. (c) First item of that template's shuffled
 * unseen list. A template with no unseen item is omitted. That omission is
 * not a switch. `template_switch` means the only template that still has an
 * unseen item is the one just used. `exhausted` means none do.
 */
function drawAtSkill(
  db: Database.Database,
  input: {
    childId: string;
    skillId: string;
    templates: ActiveTemplate[];
    step: 1 | 2 | 3;
    rng: Rng;
    since: string;
  },
): SkillDraw {
  const justHad = lastSeenTemplateId(db, input.childId, input.skillId);
  const issued = issuedOperandKeys(
    db,
    input.childId,
    input.templates.map((item) => item.template.templateId),
    input.since,
  );
  const fresh: Array<{ choice: ActiveTemplate; unseen: ReturnType<typeof eligibleDraws> }> = [];
  for (const choice of input.templates) {
    const unseen = cachedEligibleDraws(choice.template, input.step).filter((draw) => {
      const key = operandKey(draw.operands, draw.canonicalAnswer);
      return !issued.has(`${choice.template.templateId}\0${key}`);
    });
    if (unseen.length === 0) continue;
    fresh.push({ choice, unseen });
  }
  const candidates = fresh.filter((item) => item.choice.template.templateId !== justHad);
  if (candidates.length === 0) {
    return { status: fresh.length > 0 ? "template_switch" : "exhausted" };
  }
  const lastAt = lastIssuedAtByTemplate(
    db,
    input.childId,
    candidates.map((item) => item.choice.template.templateId),
  );
  const picked = pickFreshTemplate(candidates, lastAt, input.childId, input.skillId);
  if (!picked) return { status: "exhausted" };
  const draw = shuffleWith(picked.unseen, input.rng)[0];
  if (!draw) return { status: "exhausted" };
  const choice = picked.choice;
  return {
    status: "drawn",
    draw: {
      templateId: choice.template.templateId,
      templateVersion: choice.template.version,
      evidenceEligible: choice.evidenceEligible,
      operands: draw.operands,
      canonicalAnswer: draw.canonicalAnswer,
      answerLine: draw.answerLine,
      prompt: draw.prompt,
      presentation: presentationFor(choice.template, draw, input.step),
      bugHits: draw.bugs,
      repeatForced: false,
      requireForm: choice.template.requireForm ?? null,
      compareMode: choice.template.spec.compare,
      defaultFocus: choice.template.defaultFocus ?? null,
      whyItWorks: choice.template.whyItWorks ?? null,
    },
  };
}

/** Catalog order, one entry per skill. This is the practice rotation. */
function rotationSkillIds(): string[] {
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const item of ITEM_CATALOG) {
    if (seen.has(item.skill)) continue;
    seen.add(item.skill);
    skills.push(item.skill);
  }
  return skills;
}

/**
 * Skills after `skillId` in the catalog, then the skills before it.
 * A switch walks this list and skips a skill whose pool has no fresh item.
 * It does not rank pools or search from the start of the catalog.
 */
function skillsAfter(skillId: string): string[] {
  const skills = rotationSkillIds();
  const start = skills.indexOf(skillId);
  if (start < 0) return skills;
  return [...skills.slice(start + 1), ...skills.slice(0, start)];
}

function trySkill(
  db: Database.Database,
  input: {
    childId: string;
    skillId: string;
    step: 1 | 2 | 3;
    rng: Rng;
    since: string;
  },
): SkillDraw {
  const templates = loadActiveTemplates(db, input.skillId, input.step);
  if (templates.length === 0) return { status: "exhausted" };
  return drawAtSkill(db, { ...input, templates });
}

/** Last time each item of this skill and step was seen inside the no-repeat window. */
function exposuresForSkillStep(
  db: Database.Database,
  childId: string,
  skillId: string,
  step: 1 | 2 | 3,
  since: string,
): Exposure[] {
  return db
    .prepare(
      `SELECT i.template_id AS templateId, i.operand_key AS operandKey, MAX(i.issued_at) AS lastAt
       FROM item_instances i
       JOIN item_template_versions t
         ON t.template_id = i.template_id AND t.template_version = i.template_version
       WHERE i.child_id = ? AND t.skill_id = ? AND i.difficulty_step = ? AND i.issued_at >= ?
       GROUP BY i.template_id, i.operand_key`,
    )
    .all(childId, skillId, step, since) as Exposure[];
}

/**
 * Reissue the same skill and step as a new instance, copied from the row
 * seen longest ago. The copy keeps that row's template version and step.
 * `evidence_eligible` is false on the new row at issue time, so an attempt
 * on the repeat is never evidence. The original row is left unchanged.
 */
function repeatOldest(
  db: Database.Database,
  childId: string,
  skillId: string,
  step: 1 | 2 | 3,
  since: string,
): FrozenDraw | null {
  const oldest = pickOldestExposure(exposuresForSkillStep(db, childId, skillId, step, since));
  if (!oldest) return null;
  const row = db
    .prepare(
      `${INSTANCE_SELECT}
       WHERE child_id = ? AND template_id = ? AND operand_key = ? AND difficulty_step = ? AND issued_at = ?`,
    )
    .get(childId, oldest.templateId, oldest.operandKey, step, oldest.lastAt) as InstanceRow | undefined;
  if (!row || row.difficulty_step !== step) return null;
  const instance = mapInstance(db, row);
  return {
    templateId: instance.templateId,
    templateVersion: instance.templateVersion,
    evidenceEligible: false,
    operands: instance.operands,
    canonicalAnswer: instance.canonicalAnswer,
    answerLine: instance.answerLine,
    prompt: instance.prompt,
    presentation: instance.presentation,
    bugHits: instance.bugHits,
    repeatForced: true,
    requireForm: instance.requireForm,
    compareMode: instance.compareMode,
    defaultFocus: instance.defaultFocus,
    whyItWorks: instance.whyItWorks,
  };
}

function insertInstance(
  db: Database.Database,
  input: {
    childId: string;
    sessionId: string;
    idempotencyKey: string;
    issuedAt: string;
    step: number;
    draw: FrozenDraw;
    issueReason: IssueReason;
    requestedSkillId: string;
  },
): ItemInstance {
  const id = randomUUID();
  const key = operandKey(input.draw.operands, input.draw.canonicalAnswer);
  db.prepare(
    `INSERT INTO item_instances (
       item_instance_id, child_id, session_id, template_id, template_version,
       difficulty_step, operands_json, operand_key, canonical_answer, answer_line,
       prompt, presentation_json, evidence_eligible, repeat_forced, issue_reason, requested_skill_id,
       issue_idempotency_key,
       issued_at, require_form, compare_mode, bug_hits_json, default_focus, why_it_works
     ) VALUES (
       @item_instance_id, @child_id, @session_id, @template_id, @template_version,
       @difficulty_step, @operands_json, @operand_key, @canonical_answer, @answer_line,
       @prompt, @presentation_json, @evidence_eligible, @repeat_forced, @issue_reason, @requested_skill_id,
       @issue_idempotency_key,
       @issued_at, @require_form, @compare_mode, @bug_hits_json, @default_focus, @why_it_works
     )`,
  ).run({
    item_instance_id: id,
    child_id: input.childId,
    session_id: input.sessionId,
    template_id: input.draw.templateId,
    template_version: input.draw.templateVersion,
    difficulty_step: input.step,
    operands_json: JSON.stringify(input.draw.operands),
    operand_key: key,
    canonical_answer: input.draw.canonicalAnswer,
    answer_line: input.draw.answerLine,
    prompt: input.draw.prompt,
    presentation_json: JSON.stringify(input.draw.presentation),
    evidence_eligible: input.draw.evidenceEligible ? 1 : 0,
    repeat_forced: input.draw.repeatForced ? 1 : 0,
    issue_reason: input.issueReason,
    requested_skill_id: input.requestedSkillId,
    issue_idempotency_key: input.idempotencyKey,
    issued_at: input.issuedAt,
    // Frozen at issue. Reading a reason later uses this column, not the live template.
    require_form: input.draw.requireForm,
    compare_mode: input.draw.compareMode,
    bug_hits_json: JSON.stringify(input.draw.bugHits),
    default_focus: input.draw.defaultFocus,
    why_it_works: input.draw.whyItWorks,
  });
  const stored = readItemInstance(db, id);
  if (!stored) throw new DomainError("Issued item was not saved.", 500);
  return stored;
}

export function issueForProgression(
  db: Database.Database,
  input: {
    childId: string;
    sessionId: string;
    skillId: string;
    idempotencyKey: string;
    now?: string;
  },
): ItemInstance {
  const existing = readByIdempotency(db, input.sessionId, input.idempotencyKey);
  if (existing) return existing;
  const issuedAt = input.now ?? new Date().toISOString();
  const since = new Date(Date.parse(issuedAt) - REPEAT_WINDOW_MS).toISOString();
  const rng = seeded(hashSeed(`${input.idempotencyKey}:${input.childId}`));
  const requestedStep = assignedStepForSkill(input.skillId);
  // (a) Stay on the requested skill at its assigned step.
  // (b) Least-recently-seen template with an unseen item, excluding the one last issued for this skill.
  // (c) Shuffled unseen item from that template.
  // A switch happens only when (b) finds no template. The reason is template_switch
  // when the only fresh template is the one just used, otherwise exhausted_switch.
  // A repeat is the last resort.
  let picked: { step: 1 | 2 | 3; reason: IssueReason; draw: FrozenDraw } | null = null;
  const stayed = trySkill(db, {
    childId: input.childId,
    skillId: input.skillId,
    step: requestedStep,
    rng,
    since,
  });
  if (stayed.status === "drawn") {
    picked = { step: requestedStep, reason: "normal", draw: stayed.draw };
  } else {
    const reason: IssueReason = stayed.status === "template_switch" ? "template_switch" : "exhausted_switch";
    for (const skillId of skillsAfter(input.skillId)) {
      const step = assignedStepForSkill(skillId);
      const next = trySkill(db, {
        childId: input.childId,
        skillId,
        step,
        rng,
        since,
      });
      if (next.status !== "drawn") continue;
      picked = { step, reason, draw: next.draw };
      break;
    }
  }
  if (!picked) {
    const draw = repeatOldest(db, input.childId, input.skillId, requestedStep, since);
    if (draw) picked = { step: requestedStep, reason: "exhausted_repeat", draw };
  }
  if (!picked) throw new DomainError("No problem is available.", 500);
  // A switch keeps the destination template's evidence flag. A template marked
  // non-evidence stays non-evidence. Only a repeat forces evidence off.
  try {
    return insertInstance(db, {
      childId: input.childId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      issuedAt,
      step: picked.step,
      draw: picked.draw,
      issueReason: picked.reason,
      requestedSkillId: input.skillId,
    });
  } catch (error) {
    const raced = readByIdempotency(db, input.sessionId, input.idempotencyKey);
    if (raced) return raced;
    throw error;
  }
}

function unansweredCount(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM item_instances
       WHERE session_id = ? AND consumed_at IS NULL`,
    )
    .get(sessionId) as { count: number };
  return row.count;
}

function batchAlreadyIssued(
  db: Database.Database,
  sessionId: string,
  idempotencyKey: string,
  count: number,
): ItemInstance[] | null {
  const found: ItemInstance[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    const row = readByIdempotency(db, sessionId, `${idempotencyKey}:${slot}`);
    if (!row) return found.length > 0 ? found : null;
    found.push(row);
  }
  return found;
}

export function issueItemBatch(
  db: Database.Database,
  input: {
    childId: string;
    sessionId: string;
    idempotencyKey: string;
    count: number;
    itemIndex: number;
    now?: string;
  },
): ItemInstance[] {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > ISSUE_BATCH_CAP) {
    throw new DomainError("A practice batch can hold at most 3 problems.", 400);
  }
  const prior = batchAlreadyIssued(db, input.sessionId, input.idempotencyKey, input.count);
  if (prior) return prior;
  const room = OUTSTANDING_UNANSWERED_CAP - unansweredCount(db, input.sessionId);
  const toIssue = Math.min(input.count, Math.max(0, room));
  const issued: ItemInstance[] = [];
  for (let slot = 0; slot < toIssue; slot += 1) {
    const catalog = itemAt(input.itemIndex + slot);
    issued.push(
      issueForProgression(db, {
        childId: input.childId,
        sessionId: input.sessionId,
        skillId: catalog.skill,
        idempotencyKey: `${input.idempotencyKey}:${slot}`,
        now: input.now,
      }),
    );
  }
  return issued;
}

export function gradeStoredAnswer(
  instance: ItemInstance,
  given: string,
): "blank" | "unparseable" | "correct" | "incorrect" | "form_mismatch" {
  return answersMatch(instance.canonicalAnswer, given, instance.compareMode, instance.requireForm);
}

function sameStoredWrong(mode: "rational" | "exact", left: string, right: string): boolean {
  if (mode === "exact") {
    return left.replace(/\s+/g, "") === right.replace(/\s+/g, "");
  }
  return canonicalValueKey(left) === canonicalValueKey(right);
}

export function focusForStoredAnswer(
  instance: ItemInstance,
  given: string,
): { oneFocus: string; tryNext: string } {
  const hit = instance.bugHits.find((bug) => sameStoredWrong(instance.compareMode, bug.wrong, given));
  const cueKey = hit?.cueKey ?? instance.defaultFocus ?? undefined;
  const oneFocus = cueText(cueKey);
  if (!oneFocus) return { oneFocus: "", tryNext: "" };
  const tryNext = tryNextFromCue(cueKey);
  return { oneFocus, tryNext: tryNext || "Try the next one with that in mind." };
}

export function consumeItemInstance(
  db: Database.Database,
  instance: ItemInstance,
  attemptKey: string,
  consumedAt: string,
): void {
  const result = db
    .prepare(
      `UPDATE item_instances
       SET consumed_at = ?, consumed_by_attempt_key = ?
       WHERE item_instance_id = ? AND consumed_at IS NULL`,
    )
    .run(consumedAt, attemptKey, instance.itemInstanceId);
  if (result.changes !== 1) {
    throw new DomainError("That problem is already locked.", 409);
  }
}
