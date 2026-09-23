import type Database from "better-sqlite3";
import type { AttemptFuel } from "@/lib/attempt-contract";
import { PIECE_EVENT_KINDS, projectBuildGoal, type ProjectedPiece } from "@/lib/build-goal";
import {
  emberExpiryForQualifyingDay,
  localDate,
  startOfLocalDay,
} from "@/lib/local-time";
import { coolStreak, emptyStreak, heatStreak, type StreakRecord } from "@/lib/streak";

export type QualifyingDayEvent = {
  id: string;
  localDay: string;
};

export type ProjectedHeat = StreakRecord & {
  sourceEventId: string | null;
};

/**
 * Replays QualifyingPracticeDay rows through the streak machine.
 * Stored streak columns are a cache. They cannot heat the flame on their own.
 */
export function projectHeat(
  days: readonly QualifyingDayEvent[],
  timeZone: string,
  observedAt: string,
): ProjectedHeat {
  const ordered = [...days]
    .filter((day) => day.localDay.length > 0)
    .sort((a, b) => a.localDay.localeCompare(b.localDay) || a.id.localeCompare(b.id));
  let record = emptyStreak();
  let sourceEventId: string | null = null;
  const seen = new Set<string>();
  for (const day of ordered) {
    if (seen.has(day.localDay)) continue;
    seen.add(day.localDay);
    const atDay = startOfLocalDay(day.localDay, timeZone).toISOString();
    const cooled = coolStreak(record, day.localDay, atDay);
    record = heatStreak(
      cooled,
      day.localDay,
      emberExpiryForQualifyingDay(day.localDay, timeZone),
    );
    sourceEventId = day.id;
  }
  const observedDay = localDate(observedAt, timeZone);
  const cooled = coolStreak(record, observedDay, observedAt);
  return {
    ...cooled,
    sourceEventId: cooled.lastQualifyingDay ? sourceEventId : null,
  };
}

export function loadQualifyingDays(
  db: Database.Database,
  childId: string,
): QualifyingDayEvent[] {
  const rows = db
    .prepare(
      `SELECT id, local_day
       FROM qualifying_events
       WHERE child_id = ? AND kind = 'QualifyingPracticeDay' AND local_day IS NOT NULL
       ORDER BY local_day ASC, id ASC`,
    )
    .all(childId) as Array<{ id: string; local_day: string }>;
  return rows.map((row) => ({ id: row.id, localDay: row.local_day }));
}

/** Sum of XP credits that point at a QualifyingEvent. Never negative. */
export function accruedXp(db: Database.Database, childId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(e.amount), 0) AS total
       FROM xp_events e
       INNER JOIN qualifying_events q ON q.id = e.qualifying_event_id
       WHERE e.child_id = ?`,
    )
    .get(childId) as { total: number };
  if (!Number.isInteger(row.total) || row.total < 0) {
    throw new Error("XP credits cannot be clawed back.");
  }
  return row.total;
}

export type KidFuel = {
  heat: ProjectedHeat;
  accrued: number;
  pieces: ProjectedPiece[];
};

/** Kid-visible fuel. Pieces are the Slice 5 BuildGoal projection, not a second loot table. */
export function readKidFuel(
  db: Database.Database,
  childId: string,
  timeZone: string,
  observedAt: string,
): KidFuel {
  const heat = projectHeat(loadQualifyingDays(db, childId), timeZone, observedAt);
  const accrued = accruedXp(db, childId);
  const projection = projectBuildGoal(db, childId);
  const pieces = [
    ...projection.completed.flatMap((goal) => goal.pieces),
    ...projection.active.pieces,
  ];
  return { heat, accrued, pieces };
}

const PIECE_KINDS = new Set<string>(PIECE_EVENT_KINDS);

/** Fuel ids for one attempt. Credit follows the XP rows, which must point at these events. */
export function fuelFromEvents(
  events: readonly { id: string; kind: string }[],
  credit: number,
): AttemptFuel {
  if (!Number.isInteger(credit) || credit < 0) {
    throw new Error("XP credits cannot be clawed back.");
  }
  const heat = events.find((event) => event.kind === "QualifyingPracticeDay");
  return {
    credit,
    heatEventId: heat?.id ?? null,
    pieceEventIds: events.filter((event) => PIECE_KINDS.has(event.kind)).map((event) => event.id),
  };
}
