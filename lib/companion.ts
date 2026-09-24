import type Database from "better-sqlite3";
import { projectBadges, type ProjectedBadge } from "@/lib/badges";
import { projectBuildGoal, type BuildGoalProjection } from "@/lib/build-goal";
import { projectFlameRun } from "@/lib/flame-run";
import { accruedXp, loadQualifyingDays, projectHeat } from "@/lib/fuel";
import { sealFuelGlance } from "@/lib/fuel-guards";
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

/**
 * Read-only fuel numbers for the child home strip.
 * `xp` is the sum of accrue-only credits that point at QualifyingEvents.
 * `dayCount` is the consecutive qualifying-day run, or null while the flame
 * is resting and before the first qualifying day.
 * `pieces` / `goal` are the active BuildGoal. This object does not mint.
 */
export type CompanionGlance = {
  xp: number;
  dayCount: number | null;
  pieces: number;
  goal: number;
};

export type CompanionView = {
  build: BuildGoalProjection;
  badges: ProjectedBadge[];
  streak: StreakSurface;
  glance: CompanionGlance;
};

/**
 * Child companion. Build pieces and badges are projections of the bus.
 * The flame is the QualifyingPracticeDay projection, cooled to `observedAt`.
 * Opening the surface writes that projection into the streak cache.
 * `glance` is a sealed read of those same rows: the qualifying-day run,
 * the sum of XP credits that point at QualifyingEvents, and the active
 * BuildGoal. It is not a counter, and it does not feed Learner State,
 * MasteryEstimator, or band decisions.
 */
export function readCompanion(
  db: Database.Database,
  childId: string,
  observedAt: string,
): CompanionView {
  const timeZone = readChildTimeZone(db, childId);
  observeStreak(db, childId, timeZone, observedAt);
  const days = loadQualifyingDays(db, childId);
  const streak = projectHeat(days, timeZone, observedAt);
  const run = projectFlameRun(days, timeZone, observedAt);
  const build = projectBuildGoal(db, childId);
  const recovery: EmberRecovery | null =
    streak.state === "ember"
      ? {
          copyKey: "streak.ember.recover",
          detailKey: "streak.ember.recover.detail",
        }
      : null;
  return {
    build,
    badges: projectBadges(db, childId),
    streak: {
      state: streak.state,
      copyKey: STREAK_COPY[streak.state],
      emberExpiresAt: streak.emberExpiresAt,
      lastQualifyingDay: streak.lastQualifyingDay,
      sourceEventId: streak.sourceEventId,
      recovery,
    },
    glance: sealFuelGlance({
      xp: accruedXp(db, childId),
      dayCount: run.dayCount,
      pieces: build.active.pieces.length,
      goal: build.active.pieceTarget,
    }),
  };
}
