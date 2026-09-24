import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { PublicItem } from "@/lib/attempt-contract";
import { DomainError } from "@/lib/domain";
import { itemAt } from "@/lib/item-catalog";
import { answersMatch, canonicalValueKey, type RequireForm } from "@/lib/templates/rational";
import { drawAccepted, seeded, type Rng } from "@/lib/templates/engine";
import {
  issuanceTemplateSelect,
  parseIssuanceTemplate,
  type IssuanceTemplateRow,
} from "@/lib/templates/store";
import type { BugHit, TemplateVersion } from "@/lib/templates/types";
import { cueText, tryNextFromCue } from "@/lib/templates/cues";

/** Progression stays rules-v0 and serves difficulty step 1 only. */
export const PROGRESSION_DIFFICULTY_STEP = 1 as const;
export const REPEAT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const DRAW_RETRY_BOUND = 8;
export const ISSUE_BATCH_CAP = 3;

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
  issueIdempotencyKey: string;
  issuedAt: string;
  consumedAt: string | null;
  consumedByAttemptKey: string | null;
  requireForm: RequireForm | null;
  compareMode: "rational" | "exact";
  bugHits: BugHit[];
  defaultFocus: string | null;
  whyItWorks: string | null;
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

function mapInstance(row: InstanceRow): ItemInstance {
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
    issueIdempotencyKey: row.issue_idempotency_key,
    issuedAt: row.issued_at,
    consumedAt: row.consumed_at,
    consumedByAttemptKey: row.consumed_by_attempt_key,
    requireForm: row.require_form,
    compareMode: row.compare_mode,
    bugHits: JSON.parse(row.bug_hits_json) as BugHit[],
    defaultFocus: row.default_focus,
    whyItWorks: row.why_it_works,
  };
}

const INSTANCE_SELECT = `SELECT item_instance_id, child_id, session_id, template_id, template_version,
  difficulty_step, operands_json, operand_key, canonical_answer, answer_line, prompt,
  presentation_json, evidence_eligible, repeat_forced, issue_idempotency_key, issued_at,
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
  return row ? mapInstance(row) : null;
}

function readByIdempotency(
  db: Database.Database,
  sessionId: string,
  idempotencyKey: string,
): ItemInstance | null {
  const row = db
    .prepare(`${INSTANCE_SELECT} WHERE session_id = ? AND issue_idempotency_key = ?`)
    .get(sessionId, idempotencyKey) as InstanceRow | undefined;
  return row ? mapInstance(row) : null;
}

export function toPublicItem(catalog: PublicItem, instance: ItemInstance): PublicItem {
  const inline =
    instance.presentation.leading.length > 0 || instance.presentation.trailing.length > 0;
  return {
    id: catalog.id,
    pack: catalog.pack,
    grade: catalog.grade,
    skill: catalog.skill,
    prompt: instance.prompt,
    stepWord: instance.presentation.stepWord,
    itemInstanceId: instance.itemInstanceId,
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
  return toPublicItem(catalog, instance);
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

function recentlyIssued(
  db: Database.Database,
  childId: string,
  templateId: string,
  key: string,
  since: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM item_instances
       WHERE child_id = ? AND template_id = ? AND operand_key = ? AND issued_at >= ?
       LIMIT 1`,
    )
    .get(childId, templateId, key, since) as { hit: number } | undefined;
  return Boolean(row);
}

function lastTemplateId(db: Database.Database, sessionId: string): string | null {
  const row = db
    .prepare(
      `SELECT template_id FROM item_instances
       WHERE session_id = ?
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get(sessionId) as { template_id: string } | undefined;
  return row?.template_id ?? null;
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

function drawFresh(
  db: Database.Database,
  input: {
    childId: string;
    sessionId: string;
    templates: ActiveTemplate[];
    step: 1 | 2 | 3;
    rng: Rng;
    since: string;
  },
): FrozenDraw | null {
  const previous = lastTemplateId(db, input.sessionId);
  for (let attempt = 0; attempt < DRAW_RETRY_BOUND; attempt += 1) {
    const notPrevious = input.templates.filter((item) => item.template.templateId !== previous);
    const pool = notPrevious.length > 0 ? notPrevious : input.templates;
    const choice = pool[Math.floor(input.rng() * pool.length)];
    if (!choice) return null;
    const draw = drawAccepted(choice.template, input.step, input.rng, 16);
    if (!draw || draw.ambiguous) continue;
    const key = operandKey(draw.operands, draw.canonicalAnswer);
    if (recentlyIssued(db, input.childId, choice.template.templateId, key, input.since)) continue;
    return {
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
    };
  }
  return null;
}

function drawExhausted(
  db: Database.Database,
  input: {
    childId: string;
    templates: ActiveTemplate[];
    step: 1 | 2 | 3;
  },
): FrozenDraw | null {
  if (input.templates.length === 0) return null;
  const ids = input.templates.map((item) => item.template.templateId);
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT template_id AS templateId, operand_key AS operandKey, MAX(issued_at) AS lastAt
       FROM item_instances
       WHERE child_id = ? AND difficulty_step = ? AND template_id IN (${placeholders})
       GROUP BY template_id, operand_key`,
    )
    .all(input.childId, input.step, ...ids) as Exposure[];
  const picked = pickOldestExposure(rows);
  if (!picked) return null;
  const prior = db
    .prepare(
      `${INSTANCE_SELECT}
       WHERE child_id = ? AND template_id = ? AND operand_key = ? AND issued_at = ?
       ORDER BY item_instance_id ASC
       LIMIT 1`,
    )
    .get(input.childId, picked.templateId, picked.operandKey, picked.lastAt) as
    | InstanceRow
    | undefined;
  if (!prior) return null;
  const current = input.templates.find((item) => item.template.templateId === picked.templateId);
  if (!current) return null;
  const previous = mapInstance(prior);
  return {
    templateId: previous.templateId,
    templateVersion: previous.templateVersion,
    evidenceEligible: current.evidenceEligible,
    operands: previous.operands,
    canonicalAnswer: previous.canonicalAnswer,
    answerLine: previous.answerLine,
    prompt: previous.prompt,
    presentation: previous.presentation,
    bugHits: previous.bugHits,
    repeatForced: true,
    requireForm: previous.requireForm,
    compareMode: previous.compareMode,
    defaultFocus: previous.defaultFocus,
    whyItWorks: previous.whyItWorks,
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
  },
): ItemInstance {
  const id = randomUUID();
  const key = operandKey(input.draw.operands, input.draw.canonicalAnswer);
  db.prepare(
    `INSERT INTO item_instances (
       item_instance_id, child_id, session_id, template_id, template_version,
       difficulty_step, operands_json, operand_key, canonical_answer, answer_line,
       prompt, presentation_json, evidence_eligible, repeat_forced, issue_idempotency_key,
       issued_at, require_form, compare_mode, bug_hits_json, default_focus, why_it_works
     ) VALUES (
       @item_instance_id, @child_id, @session_id, @template_id, @template_version,
       @difficulty_step, @operands_json, @operand_key, @canonical_answer, @answer_line,
       @prompt, @presentation_json, @evidence_eligible, @repeat_forced, @issue_idempotency_key,
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
    issue_idempotency_key: input.idempotencyKey,
    issued_at: input.issuedAt,
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
  const step = PROGRESSION_DIFFICULTY_STEP;
  const issuedAt = input.now ?? new Date().toISOString();
  const since = new Date(Date.parse(issuedAt) - REPEAT_WINDOW_MS).toISOString();
  const templates = loadActiveTemplates(db, input.skillId, step);
  if (templates.length === 0) {
    throw new DomainError("No template is available for this skill.", 500);
  }
  const rng = seeded(hashSeed(`${input.idempotencyKey}:${input.childId}`));
  const fresh = drawFresh(db, {
    childId: input.childId,
    sessionId: input.sessionId,
    templates,
    step,
    rng,
    since,
  });
  const draw =
    fresh ??
    drawExhausted(db, {
      childId: input.childId,
      templates,
      step,
    });
  if (!draw) throw new DomainError("No problem is available.", 500);
  try {
    return insertInstance(db, {
      childId: input.childId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      issuedAt,
      step,
      draw,
    });
  } catch (error) {
    const raced = readByIdempotency(db, input.sessionId, input.idempotencyKey);
    if (raced) return raced;
    throw error;
  }
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
  const issued: ItemInstance[] = [];
  for (let slot = 0; slot < input.count; slot += 1) {
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
): "blank" | "unparseable" | "correct" | "incorrect" {
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
