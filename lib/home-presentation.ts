import type Database from "better-sqlite3";
import type { BandLabel } from "@/lib/attempt-contract";
import { itemAt } from "@/lib/item-catalog";
import { readSkillClientView, startIndexForLane, firstReviewSkill } from "@/lib/learner-state";
import { DEFAULT_PRACTICE_LANE, practiceLaneOrRecommended } from "@/lib/mastery";
import type { ConsentViewStatus } from "@/lib/practice-gate";
import type { InterfaceCopyKey } from "@/lib/interface-copy";

export type FuelStripInput = {
  started: boolean;
  dayCount: number | null;
  xp: number;
  pieces: number;
  goal: number;
};

/** One line under the practice control. Numbers, not metaphor prose. */
export function fuelStripText(input: FuelStripInput): string {
  const flame = !input.started
    ? "🔥 Start your flame"
    : input.dayCount === null
      ? "🔥 Flame resting"
      : `🔥 ${input.dayCount}-day flame`;
  return `${flame} · ⭐ ${input.xp} XP · 🧩 ${input.pieces}/${input.goal}`;
}

export function childBlockCopyKey(
  status: ConsentViewStatus,
): Extract<InterfaceCopyKey, "home.block.paused" | "home.block.revoked" | "home.block.none"> | null {
  if (status === "granted") return null;
  if (status === "paused") return "home.block.paused";
  if (status === "revoked") return "home.block.revoked";
  return "home.block.none";
}

function displayConcept(skill: string): string {
  return skill.charAt(0).toUpperCase() + skill.slice(1);
}

/**
 * Today's focus is the skill Start practice would open, plus that skill's
 * stored band. Missing state reads as Still learning. This does not start
 * a session and does not write learner progress.
 */
export function readChildFocus(
  db: Database.Database,
  childId: string,
): { concept: string; bandLabel: BandLabel } {
  const active = db
    .prepare(
      `SELECT item_index FROM practice_sessions
       WHERE child_id = ? AND status = 'active'
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get(childId) as { item_index: number } | undefined;
  let skill: string;
  if (active) {
    skill = itemAt(active.item_index).skill;
  } else {
    const progress = db
      .prepare(
        `SELECT next_lane, difficulty_step FROM learner_progress WHERE child_id = ?`,
      )
      .get(childId) as { next_lane: string; difficulty_step: number } | undefined;
    const lane = progress
      ? practiceLaneOrRecommended(progress.next_lane)
      : DEFAULT_PRACTICE_LANE;
    const step = progress?.difficulty_step ?? 0;
    const reviewSkill = lane === "review" ? firstReviewSkill(db, childId) : null;
    skill = itemAt(startIndexForLane(lane, step, reviewSkill)).skill;
  }
  const stored = readSkillClientView(db, childId, skill);
  return {
    concept: displayConcept(skill),
    bandLabel: stored?.bandLabel ?? "Still learning",
  };
}
