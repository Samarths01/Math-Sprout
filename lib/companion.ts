import type Database from "better-sqlite3";
import { projectBadges, type ProjectedBadge } from "@/lib/badges";
import { projectBuildGoal, type BuildGoalProjection } from "@/lib/build-goal";
import { loadQualifyingDays, projectHeat } from "@/lib/fuel";
import type { InterfaceCopyKey } from "@/lib/interface-copy";
import { observeStreak, readChildTimeZone } from "@/lib/qualifying-bus";
import type { StreakState } from "@/lib/streak";

const STREAK_COPY: Record<StreakState, InterfaceCopyKey> = {
  hot: "streak.hot",
  warm: "streak.warm",
  ember: "streak.ember",
  dormant: "streak.dormant",
};

export type EmberRecovery = {
  copyKey: "streak.ember.recover";
  detailKey: "streak.ember.recover.detail";
};

export type StreakSurface = {
  state: StreakState;
  copyKey: InterfaceCopyKey;
  emberExpiresAt: string | null;
  lastQualifyingDay: string | null;
  /** QualifyingPracticeDay that last heated this flame. Null when the flame has never qualified. */
  sourceEventId: string | null;
  recovery: EmberRecovery | null;
};

export type CompanionView = {
  build: BuildGoalProjection;
  badges: ProjectedBadge[];
  streak: StreakSurface;
};

/**
 * Child companion. Build pieces and badges are projections of the bus.
 * The flame is the QualifyingPracticeDay projection, cooled to `observedAt`.
 * Opening the surface writes that projection into the streak cache.
 * There is no piece balance and no XP here.
 */
export function readCompanion(
  db: Database.Database,
  childId: string,
  observedAt: string,
): CompanionView {
  const timeZone = readChildTimeZone(db, childId);
  observeStreak(db, childId, timeZone, observedAt);
  const streak = projectHeat(loadQualifyingDays(db, childId), timeZone, observedAt);
  const recovery: EmberRecovery | null =
    streak.state === "ember"
      ? {
          copyKey: "streak.ember.recover",
          detailKey: "streak.ember.recover.detail",
        }
      : null;
  return {
    build: projectBuildGoal(db, childId),
    badges: projectBadges(db, childId),
    streak: {
      state: streak.state,
      copyKey: STREAK_COPY[streak.state],
      emberExpiresAt: streak.emberExpiresAt,
      lastQualifyingDay: streak.lastQualifyingDay,
      sourceEventId: streak.sourceEventId,
      recovery,
    },
  };
}
