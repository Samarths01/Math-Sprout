import type Database from "better-sqlite3";

export type ProjectedBadge = {
  eventId: string;
  skill: string;
  band: string;
  localDay: string | null;
  createdAt: string;
};

type BadgeRow = {
  id: string;
  skill: string | null;
  local_day: string | null;
  payload_json: string;
  created_at: string;
};

function bandFromPayload(payloadJson: string): string {
  try {
    const payload = JSON.parse(payloadJson) as { band?: unknown };
    if (typeof payload.band === "string" && payload.band.length > 0) return payload.band;
  } catch {
    /* A badge with a bad payload still names the skill. */
  }
  return "Got it";
}

/** Badge screen rows. Each one is a BadgeMilestone already on the bus. */
export function projectBadges(db: Database.Database, childId: string): ProjectedBadge[] {
  const rows = db
    .prepare(
      `SELECT id, skill, local_day, payload_json, created_at
       FROM qualifying_events
       WHERE child_id = ? AND kind = 'BadgeMilestone'
       ORDER BY created_at ASC, id ASC`,
    )
    .all(childId) as BadgeRow[];
  return rows.map((row) => ({
    eventId: row.id,
    skill: row.skill && row.skill.length > 0 ? row.skill : "A skill",
    band: bandFromPayload(row.payload_json),
    localDay: row.local_day,
    createdAt: row.created_at,
  }));
}
