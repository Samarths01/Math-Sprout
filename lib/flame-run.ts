import type { QualifyingDayEvent } from "@/lib/fuel";
import {
  calendarDaysBetween,
  emberExpiryForQualifyingDay,
  localDate,
  startOfLocalDay,
} from "@/lib/local-time";
import { coolStreak, emptyStreak, heatStreak, type StreakState } from "@/lib/streak";

export type FlameRun = {
  state: StreakState;
  /**
   * Consecutive qualifying days while the flame is hot or warm.
   * Null before the first qualifying day and while the flame is resting.
   */
  dayCount: number | null;
  started: boolean;
};

function alive(state: StreakState): boolean {
  return state === "hot" || state === "warm" || state === "ember";
}

/**
 * Consecutive qualifying-day run. Replays the same cool/heat steps as the
 * flame state. It does not mint and it does not write the streak cache.
 */
export function projectFlameRun(
  days: readonly QualifyingDayEvent[],
  timeZone: string,
  observedAt: string,
): FlameRun {
  const ordered = [...days]
    .filter((day) => day.localDay.length > 0)
    .sort((a, b) => a.localDay.localeCompare(b.localDay) || a.id.localeCompare(b.id));
  let record = emptyStreak();
  let run = 0;
  const seen = new Set<string>();
  for (const day of ordered) {
    if (seen.has(day.localDay)) continue;
    seen.add(day.localDay);
    const atDay = startOfLocalDay(day.localDay, timeZone).toISOString();
    const cooled = coolStreak(record, day.localDay, atDay);
    const next = heatStreak(
      cooled,
      day.localDay,
      emberExpiryForQualifyingDay(day.localDay, timeZone),
    );
    const heated =
      next.lastQualifyingDay === day.localDay && record.lastQualifyingDay !== day.localDay;
    if (heated) {
      const consecutive =
        cooled.lastQualifyingDay !== null &&
        calendarDaysBetween(cooled.lastQualifyingDay, day.localDay) === 1 &&
        alive(cooled.state);
      run = consecutive ? run + 1 : 1;
    }
    record = next;
  }
  const observedDay = localDate(observedAt, timeZone);
  const cooled = coolStreak(record, observedDay, observedAt);
  const started = seen.size > 0;
  const lit = cooled.state === "hot" || cooled.state === "warm";
  return {
    state: cooled.state,
    dayCount: started && lit ? run : null,
    started,
  };
}
