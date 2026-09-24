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
