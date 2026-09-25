import type Database from "better-sqlite3";
import type { ClientView } from "@/lib/attempt-contract";
import { catalogItem, ITEM_CATALOG } from "@/lib/item-catalog";
import {
  DEFAULT_PRACTICE_LANE,
  practiceLaneOrRecommended,
  type PracticeLane,
  type ProgressionDecision,
  type SkillEvidence,
} from "@/lib/mastery";

export type SessionPhase = "practicing" | "boundary" | "closed";

export type PracticeSessionRow = {
  id: string;
  item_index: number;
  /** Monotonic issuance slot. The idempotency key uses this value, not the catalog index. */
  slot_seq: number;
  /** Catalog index of the first item. The first full pass of the catalog starts here. */
  lane_start: number;
  /** First overflow skill. Later overflow slots walk forward from here. */
  overflow_offset: number;
  practice_lane: PracticeLane;
  phase: SessionPhase;
  progression: ProgressionDecision | null;
};

type EvidenceRow = {
  correct: number;
  lane: string;
  practice_lane: string;
  item_id: string;
};

type SkillStateRow = {
  skill: string;
  band_label: ClientView["bandLabel"];
  show_concept_chip: number;
  celebration_tier: ClientView["celebrationTier"];
};

function nowIso(): string {
  return new Date().toISOString();
}

function asPhase(value: string): SessionPhase {
  if (value === "boundary" || value === "closed") return value;
  return "practicing";
}

function asProgression(value: string | null): ProgressionDecision | null {
  if (value === "stay" || value === "remediate" || value === "levelUpSlight") {
    return value;
  }
  return null;
}

export function readPracticeSession(
  db: Database.Database,
  childId: string,
  sessionId: string,
): PracticeSessionRow | undefined {
  const columns = new Set(
    (db.pragma("table_info(practice_sessions)") as Array<{ name: string }>).map((row) => row.name),
  );
  const slotSql = columns.has("slot_seq") ? "slot_seq" : "item_index";
  const laneStartSql = columns.has("lane_start") ? "lane_start" : "0";
  const overflowSql = columns.has("overflow_offset") ? "overflow_offset" : "0";
  const row = db
    .prepare(
      `SELECT id, item_index, ${slotSql} AS slot_seq, ${laneStartSql} AS lane_start,
              ${overflowSql} AS overflow_offset, practice_lane, phase, progression
       FROM practice_sessions
       WHERE id = ? AND child_id = ? AND status = 'active'`,
    )
    .get(sessionId, childId) as
    | {
        id: string;
        item_index: number;
        slot_seq: number;
        lane_start: number;
        overflow_offset: number;
        practice_lane: string;
        phase: string;
        progression: string | null;
      }
    | undefined;
  if (!row) return undefined;
  const practiceLane = practiceLaneOrRecommended(row.practice_lane);
  return {
    id: row.id,
    item_index: row.item_index,
    slot_seq: row.slot_seq,
    lane_start: row.lane_start,
    overflow_offset: row.overflow_offset,
    practice_lane: practiceLane,
    phase: asPhase(row.phase),
    progression: asProgression(row.progression),
  };
}

export function evidenceForSkill(
  db: Database.Database,
  childId: string,
  skill: string,
): SkillEvidence[] {
  const columns = new Set(
    (db.pragma("table_info(attempts)") as Array<{ name: string }>).map((row) => row.name),
  );
  const evidenceFilter = columns.has("estimator_evidence")
    ? "AND (a.estimator_evidence IS NULL OR a.estimator_evidence != 0)"
    : "";
  const rows = db
    .prepare(
      `SELECT a.correct AS correct, a.lane AS lane, ps.practice_lane AS practice_lane,
              a.item_id AS item_id
       FROM attempts a
       JOIN practice_sessions ps ON ps.id = a.session_id
       WHERE a.child_id = ?
       ${evidenceFilter}
       ORDER BY a.submitted_at ASC, a.created_at ASC, a.id ASC`,
    )
    .all(childId) as EvidenceRow[];

  const evidence: SkillEvidence[] = [];
  for (const row of rows) {
    if (catalogItem(row.item_id)?.skill !== skill) continue;
    evidence.push({
      correct: row.correct === 1,
      lane: row.lane === "celebrate" ? "celebrate" : "review",
      practiceLane: practiceLaneOrRecommended(row.practice_lane),
    });
  }
  return evidence;
}

export function saveSkillState(
  db: Database.Database,
  childId: string,
  skill: string,
  view: ClientView,
): void {
  db.prepare(
    `INSERT INTO learner_skill_state (
       child_id, skill, band_label, show_concept_chip, celebration_tier, updated_at
     ) VALUES (
       @child_id, @skill, @band_label, @show_concept_chip, @celebration_tier, @updated_at
     )
     ON CONFLICT(child_id, skill) DO UPDATE SET
       band_label = excluded.band_label,
       show_concept_chip = excluded.show_concept_chip,
       celebration_tier = excluded.celebration_tier,
       updated_at = excluded.updated_at`,
  ).run({
    child_id: childId,
    skill,
    band_label: view.bandLabel,
    show_concept_chip: view.showConceptChip ? 1 : 0,
    celebration_tier: view.celebrationTier,
    updated_at: nowIso(),
  });
}

export function readSkillClientView(
  db: Database.Database,
  childId: string,
  skill: string,
): ClientView | null {
  const row = db
    .prepare(
      `SELECT band_label, show_concept_chip, celebration_tier
       FROM learner_skill_state
       WHERE child_id = ? AND skill = ?`,
    )
    .get(childId, skill) as Omit<SkillStateRow, "skill"> | undefined;
  if (!row) return null;
  return {
    bandLabel: row.band_label,
    showConceptChip: row.show_concept_chip === 1,
    celebrationTier: row.celebration_tier,
  };
}

export function skillsShortOfGotIt(
  db: Database.Database,
  childId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT skill, band_label FROM learner_skill_state
       WHERE child_id = ? AND band_label != 'Got it'
       ORDER BY skill ASC`,
    )
    .all(childId) as Array<{ skill: string; band_label: string }>;
  return rows.map((row) => row.skill);
}

export type LearnerProgress = {
  nextLane: PracticeLane;
  difficultyStep: number;
};

export function ensureLearnerProgress(
  db: Database.Database,
  childId: string,
): LearnerProgress {
  db.prepare(
    `INSERT INTO learner_progress (child_id, next_lane, difficulty_step, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(child_id) DO NOTHING`,
  ).run(childId, DEFAULT_PRACTICE_LANE, nowIso());
  const row = db
    .prepare(
      `SELECT next_lane, difficulty_step FROM learner_progress WHERE child_id = ?`,
    )
    .get(childId) as { next_lane: string; difficulty_step: number };
  return {
    nextLane: practiceLaneOrRecommended(row.next_lane),
    difficultyStep: row.difficulty_step,
  };
}

export function setNextLane(
  db: Database.Database,
  childId: string,
  lane: PracticeLane,
): void {
  ensureLearnerProgress(db, childId);
  db.prepare(
    `UPDATE learner_progress SET next_lane = ?, updated_at = ? WHERE child_id = ?`,
  ).run(lane, nowIso(), childId);
}

export function bumpDifficulty(db: Database.Database, childId: string): void {
  ensureLearnerProgress(db, childId);
  db.prepare(
    `UPDATE learner_progress
     SET difficulty_step = difficulty_step + 1, updated_at = ?
     WHERE child_id = ?`,
  ).run(nowIso(), childId);
}

export function readDifficulty(db: Database.Database, childId: string): number {
  return ensureLearnerProgress(db, childId).difficultyStep;
}

/**
 * Recommended starts at the child's step. Challenge is one grade harder.
 * Review opens on a skill that is still short of Got it.
 */
export function startIndexForLane(
  lane: PracticeLane,
  difficultyStep: number,
  reviewSkill: string | null,
): number {
  if (lane === "review" && reviewSkill) {
    const reviewIndex = ITEM_CATALOG.findIndex((item) => item.skill === reviewSkill);
    if (reviewIndex >= 0) return reviewIndex;
  }
  const grade = Math.min(4, 2 + difficultyStep + (lane === "challenge" ? 1 : 0));
  const index = ITEM_CATALOG.findIndex((item) => item.grade >= grade);
  return index >= 0 ? index : 0;
}

export function firstReviewSkill(
  db: Database.Database,
  childId: string,
): string | null {
  const remaining = skillsShortOfGotIt(db, childId);
  if (remaining.length === 0) return null;
  const catalogOrder = ITEM_CATALOG.map((item) => item.skill);
  return (
    remaining
      .slice()
      .sort((a, b) => catalogOrder.indexOf(a) - catalogOrder.indexOf(b))[0] ?? null
  );
}
