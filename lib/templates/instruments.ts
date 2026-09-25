import type Database from "better-sqlite3";
import { answerKindForTemplate } from "@/lib/templates/format-example";
import { REPEAT_WINDOW_MS } from "@/lib/templates/issue";

export type RepeatRate = {
  forced: number;
  issued: number;
  rate: number;
};

/** Exact repeats inside the 7-day window. Forced repeats are the numerator. */
export function exactRepeatRate(
  db: Database.Database,
  childId: string,
  now: string,
): RepeatRate {
  const since = new Date(Date.parse(now) - REPEAT_WINDOW_MS).toISOString();
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN repeat_forced = 1 THEN 1 ELSE 0 END) AS forced,
         COUNT(*) AS issued
       FROM item_instances
       WHERE child_id = ? AND issued_at >= ?`,
    )
    .get(childId, since) as { forced: number | null; issued: number };
  const forced = row.forced ?? 0;
  const issued = row.issued;
  return {
    forced,
    issued,
    rate: issued === 0 ? 0 : forced / issued,
  };
}

export type ExhaustionEventCount = {
  skill: string;
  templateId: string;
  templateVersion: number;
  step: number;
  reason: "exhausted_switch" | "exhausted_repeat";
  count: number;
};

/**
 * Dev count of exhaustion fallbacks. Grouped by skill, template version, and
 * the step that was issued. Not an estimator, band, or child-payload input.
 */
export function exhaustionEventCounts(
  db: Database.Database,
  childId: string,
): ExhaustionEventCount[] {
  return db
    .prepare(
      `SELECT
         t.skill_id AS skill,
         i.template_id AS templateId,
         i.template_version AS templateVersion,
         i.difficulty_step AS step,
         i.issue_reason AS reason,
         COUNT(*) AS count
       FROM item_instances i
       JOIN item_template_versions t
         ON t.template_id = i.template_id AND t.template_version = i.template_version
       WHERE i.child_id = ? AND i.issue_reason IN ('exhausted_switch', 'exhausted_repeat')
       GROUP BY t.skill_id, i.template_id, i.template_version, i.difficulty_step, i.issue_reason
       ORDER BY t.skill_id ASC, i.template_id ASC, i.template_version ASC, i.difficulty_step ASC, i.issue_reason ASC`,
    )
    .all(childId) as ExhaustionEventCount[];
}

export type PoolIssuanceCount = {
  skill: string;
  templateId: string;
  templateVersion: number;
  step: number;
  issued: number;
  exhaustedSwitch: number;
  exhaustedRepeat: number;
  /** `exhaustedSwitch / issued` for this pool. Zero when nothing was issued. */
  switchRate: number;
};

/**
 * Dev readout for a dogfood run. Runtime counts of every issued item in each
 * (requested skill, step, template version) pool, plus switch and repeat counts.
 * A switch is credited to the skill that was requested. Older rows with no
 * stored request fall back to the template skill.
 * Not an estimator input, and not a child or parent field.
 */
export function poolIssuanceCounts(db: Database.Database, childId: string): PoolIssuanceCount[] {
  const rows = db
    .prepare(
      `SELECT
         COALESCE(i.requested_skill_id, t.skill_id) AS skill,
         i.template_id AS templateId,
         i.template_version AS templateVersion,
         i.difficulty_step AS step,
         COUNT(*) AS issued,
         SUM(CASE WHEN i.issue_reason = 'exhausted_switch' THEN 1 ELSE 0 END) AS exhaustedSwitch,
         SUM(CASE WHEN i.issue_reason = 'exhausted_repeat' THEN 1 ELSE 0 END) AS exhaustedRepeat
       FROM item_instances i
       JOIN item_template_versions t
         ON t.template_id = i.template_id AND t.template_version = i.template_version
       WHERE i.child_id = ?
       GROUP BY COALESCE(i.requested_skill_id, t.skill_id), i.template_id, i.template_version, i.difficulty_step
       ORDER BY skill ASC, i.template_id ASC, i.template_version ASC, i.difficulty_step ASC`,
    )
    .all(childId) as Array<{
    skill: string;
    templateId: string;
    templateVersion: number;
    step: number;
    issued: number;
    exhaustedSwitch: number;
    exhaustedRepeat: number;
  }>;
  return rows.map((row) => ({
    ...row,
    switchRate: row.issued === 0 ? 0 : row.exhaustedSwitch / row.issued,
  }));
}

export type StepPractice = {
  skill: string;
  step: number;
  count: number;
};

export type FormatRejectRate = {
  templateId: string;
  templateVersion: number;
  provenance: string;
  answerKind: string;
  totalRejects: number;
  distinctRejectedItems: number;
  servedItems: number;
  /** Headline: distinct rejected items divided by items served. */
  rate: number;
  /** Secondary: every reject event divided by items served. */
  totalRate: number;
};

/**
 * Headline rate is distinct rejected items / items served, grouped by template,
 * version, provenance, and answer kind. `totalRejects` counts every event,
 * including three rejects of one item. These rows are not estimator, band, or fuel input.
 */
export function formatRejectRates(db: Database.Database, childId: string): FormatRejectRate[] {
  const served = db
    .prepare(
      `SELECT
         i.template_id AS templateId,
         i.template_version AS templateVersion,
         t.provenance AS provenance,
         json_extract(t.spec_json, '$.family') AS family,
         COUNT(*) AS servedItems
       FROM item_instances i
       JOIN item_template_versions t
         ON t.template_id = i.template_id AND t.template_version = i.template_version
       WHERE i.child_id = ?
       GROUP BY i.template_id, i.template_version, t.provenance, family`,
    )
    .all(childId) as Array<{
    templateId: string;
    templateVersion: number;
    provenance: string;
    family: string;
    servedItems: number;
  }>;
  const rejects = db
    .prepare(
      `SELECT
         i.template_id AS templateId,
         r.template_version AS templateVersion,
         r.provenance AS provenance,
         r.answer_kind AS answerKind,
         COUNT(*) AS totalRejects,
         COUNT(DISTINCT r.item_instance_id) AS distinctRejectedItems
       FROM answer_format_rejects r
       JOIN item_instances i ON i.item_instance_id = r.item_instance_id
       WHERE i.child_id = ?
       GROUP BY i.template_id, r.template_version, r.provenance, r.answer_kind`,
    )
    .all(childId) as Array<{
    templateId: string;
    templateVersion: number;
    provenance: string;
    answerKind: string;
    totalRejects: number;
    distinctRejectedItems: number;
  }>;
  const buckets = new Map<string, FormatRejectRate>();
  const touch = (templateId: string, templateVersion: number, provenance: string, answerKind: string) => {
    const id = `${templateId}\0${templateVersion}\0${provenance}\0${answerKind}`;
    const existing = buckets.get(id);
    if (existing) return existing;
    const created: FormatRejectRate = {
      templateId,
      templateVersion,
      provenance,
      answerKind,
      totalRejects: 0,
      distinctRejectedItems: 0,
      servedItems: 0,
      rate: 0,
      totalRate: 0,
    };
    buckets.set(id, created);
    return created;
  };
  for (const row of served) {
    const bucket = touch(
      row.templateId,
      row.templateVersion,
      row.provenance,
      answerKindForTemplate(row.family),
    );
    bucket.servedItems += row.servedItems;
  }
  for (const row of rejects) {
    const bucket = touch(row.templateId, row.templateVersion, row.provenance, row.answerKind);
    bucket.totalRejects += row.totalRejects;
    bucket.distinctRejectedItems += row.distinctRejectedItems;
  }
  return [...buckets.values()]
    .sort(
      (left, right) =>
        left.templateId.localeCompare(right.templateId) ||
        left.templateVersion - right.templateVersion ||
        left.provenance.localeCompare(right.provenance) ||
        left.answerKind.localeCompare(right.answerKind),
    )
    .map((row) => ({
      ...row,
      rate: row.servedItems === 0 ? 0 : row.distinctRejectedItems / row.servedItems,
      totalRate: row.servedItems === 0 ? 0 : row.totalRejects / row.servedItems,
    }));
}

/** Difficulty step practiced per skill, from issued instances. */
export function stepsPracticed(db: Database.Database, childId: string): StepPractice[] {
  const rows = db
    .prepare(
      `SELECT t.skill_id AS skill, i.difficulty_step AS step, COUNT(*) AS count
       FROM item_instances i
       JOIN item_template_versions t
         ON t.template_id = i.template_id AND t.template_version = i.template_version
       WHERE i.child_id = ?
       GROUP BY t.skill_id, i.difficulty_step
       ORDER BY t.skill_id ASC, i.difficulty_step ASC`,
    )
    .all(childId) as StepPractice[];
  return rows;
}
