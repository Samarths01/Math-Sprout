import type { CelebrationTier } from "@/lib/attempt-contract";
import type { StreakState } from "@/lib/streak";

/**
 * How the kid surface may move. Minting requires a QualifyingEvent on this try.
 * Waning is the flame cooling from the last qualifying day. It is not a reward.
 */
export type FuelMotionKind = "mint" | "wane" | "steady";

const HEAT_RANK: Record<StreakState, number> = {
  dormant: 0,
  ember: 1,
  warm: 2,
  hot: 3,
};

export function xpBacked(input: {
  credit: number;
  eventCount: number;
  tier: CelebrationTier;
}): boolean {
  return (
    input.credit > 0 &&
    input.eventCount > 0 &&
    (input.tier === "full" || input.tier === "quietXp")
  );
}

/**
 * Practice may animate fuel only from QualifyingEvent-derived state.
 * A hotter flame without a heat event stays steady. A first paint does not mint.
 */
export function fuelMotion(input: {
  previousHeat: StreakState | null;
  nextHeat: StreakState | null;
  previousPieceIds: readonly string[] | null;
  nextPieceIds: readonly string[];
  credit: number;
  heatEventId: string | null;
  replayed: boolean;
}): { heat: FuelMotionKind; pieces: FuelMotionKind; xp: FuelMotionKind } {
  const xp: FuelMotionKind = input.credit > 0 && !input.replayed ? "mint" : "steady";

  let heat: FuelMotionKind = "steady";
  if (input.previousHeat && input.nextHeat) {
    const delta = HEAT_RANK[input.nextHeat] - HEAT_RANK[input.previousHeat];
    if (delta > 0 && input.heatEventId && !input.replayed) heat = "mint";
    else if (delta < 0) heat = "wane";
  }

  let pieces: FuelMotionKind = "steady";
  if (input.previousPieceIds) {
    const before = new Set(input.previousPieceIds);
    if (input.nextPieceIds.some((id) => !before.has(id))) pieces = "mint";
  }

  return { heat, pieces, xp };
}
