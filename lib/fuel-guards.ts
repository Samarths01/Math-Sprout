/**
 * Fuel glance guards. The three home numbers are a sealed read of rows that
 * already exist. They are not a counter, they never decrease, and they do
 * not rank children.
 */

export const FUEL_GLANCE_KEYS = ["xp", "dayCount", "pieces", "goal"] as const;

export type FuelGlance = {
  xp: number;
  dayCount: number | null;
  pieces: number;
  goal: number;
};

const RANKING_COPY =
  /leaderboard|ranking|\brank\b|ahead of|behind|versus|\bvs\b/i;

/**
 * Keep only the four fuel fields. XP is a non-negative integer. A day count
 * is a positive run, or null while the flame is resting. Pieces cannot be
 * negative. The active goal has a target of at least one.
 */
export function sealFuelGlance(input: FuelGlance): FuelGlance {
  if (!Number.isInteger(input.xp) || input.xp < 0) {
    throw new Error("XP credits cannot be clawed back.");
  }
  if (
    input.dayCount !== null &&
    (!Number.isInteger(input.dayCount) || input.dayCount < 1)
  ) {
    throw new Error("A flame run is a qualifying-day count, or it is resting.");
  }
  if (!Number.isInteger(input.pieces) || input.pieces < 0) {
    throw new Error("Build pieces are a projection of the bus.");
  }
  if (!Number.isInteger(input.goal) || input.goal < 1) {
    throw new Error("The active build goal has a target.");
  }
  return {
    xp: input.xp,
    dayCount: input.dayCount,
    pieces: input.pieces,
    goal: input.goal,
  };
}

/** Fuel copy states the numbers. It does not compare children. */
export function assertFuelCopy(text: string): string {
  if (RANKING_COPY.test(text)) {
    throw new Error("Fuel copy does not rank or compare.");
  }
  return text;
}
