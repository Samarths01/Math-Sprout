import type Database from "better-sqlite3";
import { answerKindFor } from "@/lib/templates/format-example";
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

export type StepPractice = {
  skill: string;
  step: number;
  count: number;
};

export type FormatRejectRate = {
  templateVersion: number;
  provenance: string;
  answerKind: string;
  rejects: number;
  attempts: number;
  rate: number;
};

/**
 * Rejects divided by rejects plus scored attempts, per template version,
 * provenance, and answer kind. The child's text is not in this table.
 * These rows are a rate only. They are not estimator, band, or fuel input.
 */
export function formatRejectRates(db: Database.Database, childId: string): FormatRejectRate[] {
  const rejects = db
    .prepare(
      `SELECT
         r.template_version AS templateVersion,
         r.provenance AS provenance,
         r.answer_kind AS answerKind,
         COUNT(*) AS rejects
       FROM answer_format_rejects r
       JOIN item_instances i ON i.item_instance_id = r.item_instance_id
       WHERE i.child_id = ?
       GROUP BY r.template_version, r.provenance, r.answer_kind`,
    )
    .all(childId) as Array<{
    templateVersion: number;
    provenance: string;
    answerKind: string;
    rejects: number;
  }>;
  const attempts = db
    .prepare(
      `SELECT
         i.template_version AS templateVersion,
         t.provenance AS provenance,
         i.canonical_answer AS canonicalAnswer
       FROM attempts a
       JOIN item_instances i ON i.item_instance_id = a.item_instance_id
       JOIN item_template_versions t
         ON t.template_id = i.template_id AND t.template_version = i.template_version
       WHERE a.child_id = ?`,
    )
    .all(childId) as Array<{
    templateVersion: number;
    provenance: string;
    canonicalAnswer: string;
  }>;
  const buckets = new Map<string, FormatRejectRate>();
  const touch = (templateVersion: number, provenance: string, answerKind: string) => {
    const id = `${templateVersion}\0${provenance}\0${answerKind}`;
    const existing = buckets.get(id);
    if (existing) return existing;
    const created: FormatRejectRate = {
      templateVersion,
      provenance,
      answerKind,
      rejects: 0,
      attempts: 0,
      rate: 0,
    };
    buckets.set(id, created);
    return created;
  };
  for (const row of rejects) {
    touch(row.templateVersion, row.provenance, row.answerKind).rejects += row.rejects;
  }
  for (const row of attempts) {
    touch(row.templateVersion, row.provenance, answerKindFor(row.canonicalAnswer)).attempts += 1;
  }
  return [...buckets.values()]
    .sort(
      (left, right) =>
        left.templateVersion - right.templateVersion ||
        left.provenance.localeCompare(right.provenance) ||
        left.answerKind.localeCompare(right.answerKind),
    )
    .map((row) => {
      const total = row.rejects + row.attempts;
      return { ...row, rate: total === 0 ? 0 : row.rejects / total };
    });
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
