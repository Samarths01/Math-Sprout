import { calendarDaysBetween } from "@/lib/local-time";

export const STREAK_STATES = ["hot", "warm", "ember", "dormant"] as const;

export type StreakState = (typeof STREAK_STATES)[number];

export type StreakRecord = {
  state: StreakState;
  emberExpiresAt: string | null;
  lastQualifyingDay: string | null;
};

export function emptyStreak(): StreakRecord {
  return { state: "dormant", emberExpiresAt: null, lastQualifyingDay: null };
}

/**
 * Time passing cools the flame. It never heats.
 * The day after a qualifying day is Ember until `emberExpiresAt`.
 * After that instant the flame is Dormant. The last qualifying day stays stored.
 */
export function coolStreak(record: StreakRecord, today: string, nowIso: string): StreakRecord {
  if (!record.lastQualifyingDay) return emptyStreak();
  if (record.lastQualifyingDay === today) return record;
  if (record.emberExpiresAt && nowIso < record.emberExpiresAt) {
    return { ...record, state: "ember" };
  }
  return {
    state: "dormant",
    emberExpiresAt: record.emberExpiresAt,
    lastQualifyingDay: record.lastQualifyingDay,
  };
}

/**
 * A QualifyingPracticeDay heats one step when the previous qualifying day was yesterday
 * and the flame is still alive (Hot, Warm, or Ember). Any other gap starts at Warm.
 * The same local day is a no-op so a second try cannot heat twice.
 */
export function heatStreak(
  cooled: StreakRecord,
  today: string,
  emberExpiresAt: string,
): StreakRecord {
  if (cooled.lastQualifyingDay === today) return cooled;
  const consecutive =
    cooled.lastQualifyingDay !== null &&
    calendarDaysBetween(cooled.lastQualifyingDay, today) === 1;
  const alive = cooled.state === "hot" || cooled.state === "warm" || cooled.state === "ember";
  return {
    state: consecutive && alive ? "hot" : "warm",
    lastQualifyingDay: today,
    emberExpiresAt,
  };
}
