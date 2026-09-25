import type Database from "better-sqlite3";
import { responseLatencyMs, type BandLabel } from "@/lib/attempt-contract";
import { getChild } from "@/lib/domain";
import { interfaceCopy } from "@/lib/interface-copy";
import { catalogItem } from "@/lib/item-catalog";
import { localDate } from "@/lib/local-time";

/**
 * One-breath parent card. Aggregates of committed practice for the child's
 * local today: minutes, the focus concept, and that concept's band.
 * Band movement is the latest MasteryBandTransition on the bus. A held band
 * is the stored soft-state label when nothing moved.
 * This read has no attempt list, answer, score, confidence, or deep link.
 */
export type BandMovement = {
  from: BandLabel | null;
  to: BandLabel | null;
  moved: boolean;
};

export type ParentSummary = {
  childId: string;
  localDay: string;
  practiced: boolean;
  minutes: number;
  focusConcept: string | null;
  bandMovement: BandMovement;
  story: string;
};

export const PARENT_SUMMARY_KEYS = [
  "childId",
  "localDay",
  "practiced",
  "minutes",
  "focusConcept",
  "bandMovement",
  "story",
] as const;

const EMPTY_MOVEMENT: BandMovement = { from: null, to: null, moved: false };

type SpanRow = {
  item_id: string;
  shown_at: string;
  submitted_at: string;
};

type TransitionRow = {
  skill: string | null;
  payload_json: string;
  created_at: string;
  id: string;
};

function isBandLabel(value: unknown): value is BandLabel {
  return (
    value === "Still learning" || value === "Getting it" || value === "Got it"
  );
}

export function glanceMinutes(summary: Pick<ParentSummary, "practiced" | "minutes">): string {
  if (!summary.practiced) return "Today · no practice yet";
  if (summary.minutes <= 0) return "Today · under a minute";
  return `Today · ${summary.minutes} min`;
}

export function glanceFocus(focusConcept: string | null): string {
  return focusConcept ? `Focus: ${focusConcept}` : "Focus: none yet";
}

/** Soft-state labels only. An arrow appears only when the band actually moved. */
export function glanceBand(movement: BandMovement): string {
  if (!movement.to) return interfaceCopy("parent.breath.noBand");
  if (movement.moved && movement.from && movement.from !== movement.to) {
    return `${movement.from} → ${movement.to}`;
  }
  return movement.to;
}

function storyFor(summary: Omit<ParentSummary, "story">, everPracticed: boolean): string {
  if (!summary.practiced) {
    return everPracticed
      ? interfaceCopy("parent.breath.emptyToday")
      : interfaceCopy("parent.breath.empty");
  }
  return `${glanceMinutes(summary)}. ${glanceFocus(summary.focusConcept)}. ${glanceBand(summary.bandMovement)}.`;
}

function readTransition(payload: string): { from: BandLabel | null; to: BandLabel | null } {
  try {
    const parsed = JSON.parse(payload) as { from?: unknown; to?: unknown };
    const from =
      parsed.from === null || parsed.from === undefined
        ? null
        : isBandLabel(parsed.from)
          ? parsed.from
          : null;
    const to = isBandLabel(parsed.to) ? parsed.to : null;
    return { from, to };
  } catch {
    return { from: null, to: null };
  }
}

function heldBand(
  db: Database.Database,
  childId: string,
  skill: string,
): BandLabel | null {
  const row = db
    .prepare(
      `SELECT band_label FROM learner_skill_state WHERE child_id = ? AND skill = ?`,
    )
    .get(childId, skill) as { band_label: string } | undefined;
  return isBandLabel(row?.band_label) ? row.band_label : null;
}

/**
 * Focus is the skill with the most committed answering time today.
 * The same skill's latest band transition is the movement. Other skills
 * stay off the card so this stays one breath, not an attempt history.
 */
function focusConcept(
  spans: SpanRow[],
): { skill: string; lastSubmittedAt: string } | null {
  const bySkill = new Map<string, { ms: number; last: string }>();
  for (const span of spans) {
    const skill = catalogItem(span.item_id)?.skill;
    if (!skill) continue;
    const current = bySkill.get(skill) ?? { ms: 0, last: span.submitted_at };
    current.ms += responseLatencyMs(span.shown_at, span.submitted_at);
    if (span.submitted_at >= current.last) current.last = span.submitted_at;
    bySkill.set(skill, current);
  }
  let chosen: { skill: string; lastSubmittedAt: string } | null = null;
  let bestMs = -1;
  for (const [skill, agg] of bySkill) {
    if (
      agg.ms > bestMs ||
      (agg.ms === bestMs && chosen && agg.last > chosen.lastSubmittedAt)
    ) {
      chosen = { skill, lastSubmittedAt: agg.last };
      bestMs = agg.ms;
    }
  }
  return chosen;
}

function movementFor(
  db: Database.Database,
  childId: string,
  skill: string,
  transitions: TransitionRow[],
): BandMovement {
  const latest = [...transitions]
    .reverse()
    .find((row) => row.skill === skill);
  if (!latest) {
    return { from: null, to: heldBand(db, childId, skill), moved: false };
  }
  const parsed = readTransition(latest.payload_json);
  if (!parsed.to) {
    return { from: null, to: heldBand(db, childId, skill), moved: false };
  }
  return {
    from: parsed.from,
    to: parsed.to,
    moved: parsed.from !== null && parsed.from !== parsed.to,
  };
}

export function readParentSummary(
  db: Database.Database,
  guardianId: string,
  childId: string,
  now = new Date().toISOString(),
): ParentSummary {
  const child = getChild(db, guardianId, childId);
  const localDay = localDate(now, child.timezone);
  const ever = db
    .prepare(`SELECT COUNT(*) AS count FROM attempts WHERE child_id = ?`)
    .get(childId) as { count: number };
  const spans = db
    .prepare(
      `SELECT item_id, shown_at, submitted_at
       FROM attempts
       WHERE child_id = ?
       ORDER BY submitted_at ASC, id ASC`,
    )
    .all(childId) as SpanRow[];
  const today = spans.filter(
    (span) => localDate(span.submitted_at, child.timezone) === localDay,
  );
  const practiced = today.length > 0;
  const minutes = Math.floor(
    today.reduce((sum, span) => sum + responseLatencyMs(span.shown_at, span.submitted_at), 0) /
      60_000,
  );
  const focus = practiced ? focusConcept(today) : null;
  const transitions = practiced
    ? (db
        .prepare(
          `SELECT skill, payload_json, created_at, id
           FROM qualifying_events
           WHERE child_id = ? AND kind = 'MasteryBandTransition' AND local_day = ?
           ORDER BY rowid ASC`,
        )
        .all(childId, localDay) as TransitionRow[])
    : [];
  const bandMovement = focus
    ? movementFor(db, childId, focus.skill, transitions)
    : EMPTY_MOVEMENT;
  const summary: Omit<ParentSummary, "story"> = {
    childId: child.id,
    localDay,
    practiced,
    minutes: practiced ? minutes : 0,
    focusConcept: focus?.skill ?? null,
    bandMovement,
  };
  return {
    ...summary,
    story: storyFor(summary, ever.count > 0),
  };
}
