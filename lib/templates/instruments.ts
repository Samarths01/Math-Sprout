import type Database from "better-sqlite3";
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
  promptType: string;
  rejects: number;
  attempts: number;
  rate: number;
};

/**
 * Rejects divided by rejects plus scored attempts, per template version,
 * provenance, and prompt type. The child's text is not in this table.
 */
export function formatRejectRates(db: Database.Database, childId: string): FormatRejectRate[] {
  const rows = db
    .prepare(
      `SELECT
         version AS templateVersion,
         provenance AS provenance,
         prompt_type AS promptType,
         SUM(rejects) AS rejects,
         SUM(attempts) AS attempts
       FROM (
         SELECT
           r.template_version AS version,
           r.provenance AS provenance,
           r.prompt_type AS prompt_type,
           COUNT(*) AS rejects,
           0 AS attempts
         FROM answer_format_rejects r
         JOIN item_instances i ON i.item_instance_id = r.item_instance_id
         WHERE i.child_id = ?
         GROUP BY r.template_version, r.provenance, r.prompt_type
         UNION ALL
         SELECT
           i.template_version AS version,
           t.provenance AS provenance,
           t.prompt_shape AS prompt_type,
           0 AS rejects,
           COUNT(*) AS attempts
         FROM attempts a
         JOIN item_instances i ON i.item_instance_id = a.item_instance_id
         JOIN item_template_versions t
           ON t.template_id = i.template_id AND t.template_version = i.template_version
         WHERE a.child_id = ?
         GROUP BY i.template_version, t.provenance, t.prompt_shape
       )
       GROUP BY version, provenance, prompt_type
       ORDER BY version ASC, provenance ASC, prompt_type ASC`,
    )
    .all(childId, childId) as Array<{
    templateVersion: number;
    provenance: string;
    promptType: string;
    rejects: number | null;
    attempts: number | null;
  }>;
  return rows.map((row) => {
    const rejects = row.rejects ?? 0;
    const attempts = row.attempts ?? 0;
    const total = rejects + attempts;
    return {
      templateVersion: row.templateVersion,
      provenance: row.provenance,
      promptType: row.promptType,
      rejects,
      attempts,
      rate: total === 0 ? 0 : rejects / total,
    };
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
