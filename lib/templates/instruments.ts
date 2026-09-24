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

export type UnparseableRate = {
  templateId: string;
  templateVersion: number;
  provenance: string;
  unparseable: number;
  attempts: number;
  rate: number;
};

/**
 * Unparseable attempts divided by attempts on that template version.
 * Provenance stays on the template row and is joined, not copied onto the child payload.
 */
export function unparseableRates(db: Database.Database, childId: string): UnparseableRate[] {
  const rows = db
    .prepare(
      `SELECT
         i.template_id AS templateId,
         i.template_version AS templateVersion,
         t.provenance AS provenance,
         SUM(CASE WHEN a.outcome = 'unparseable' THEN 1 ELSE 0 END) AS unparseable,
         COUNT(*) AS attempts
       FROM attempts a
       JOIN item_instances i ON i.item_instance_id = a.item_instance_id
       JOIN item_template_versions t
         ON t.template_id = i.template_id AND t.template_version = i.template_version
       WHERE a.child_id = ?
       GROUP BY i.template_id, i.template_version, t.provenance
       ORDER BY i.template_id ASC, i.template_version ASC, t.provenance ASC`,
    )
    .all(childId) as Array<{
    templateId: string;
    templateVersion: number;
    provenance: string;
    unparseable: number | null;
    attempts: number;
  }>;
  return rows.map((row) => {
    const unparseable = row.unparseable ?? 0;
    const attempts = row.attempts;
    return {
      templateId: row.templateId,
      templateVersion: row.templateVersion,
      provenance: row.provenance,
      unparseable,
      attempts,
      rate: attempts === 0 ? 0 : unparseable / attempts,
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
