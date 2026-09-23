import type Database from "better-sqlite3";
import type { InterfaceCopyKey } from "@/lib/interface-copy";

/**
 * Fixed build shapes. This is not a loot table: nothing rolls a reward,
 * and nothing here can be bought or skipped.
 * One goal is active. The next one opens only after the active goal is full.
 */
export const BUILD_GOALS = [
  { id: "pot", title: "A pot for the sprout", pieceTarget: 3 },
  { id: "sunny-spot", title: "A sunny spot", pieceTarget: 3 },
  { id: "window-box", title: "The window box", pieceTarget: 4 },
] as const;

export type BuildGoalId = (typeof BUILD_GOALS)[number]["id"];

/**
 * Piece rows are these bus kinds only.
 * A streak milestone is the BuildPieceUnlock the bus already mints when the
 * flame becomes hot (`payload.source = streak_hot`). QualifyingPracticeDay
 * stays heat for the streak machine. It is not a second piece.
 */
export const PIECE_EVENT_KINDS = ["BadgeMilestone", "BuildPieceUnlock", "LevelUpSlight"] as const;

export type PieceEventKind = (typeof PIECE_EVENT_KINDS)[number];

export const PIECE_ROLES = ["badge", "level", "build", "streak"] as const;

export type PieceRole = (typeof PIECE_ROLES)[number];

export type ProjectedPiece = {
  eventId: string;
  kind: PieceEventKind;
  role: PieceRole;
  copyKey: InterfaceCopyKey;
  skill: string | null;
  localDay: string | null;
  createdAt: string;
};

export type ProjectedGoal = {
  id: BuildGoalId;
  title: string;
  pieceTarget: number;
  pieces: ProjectedPiece[];
  complete: boolean;
  active: boolean;
};

export type BuildGoalProjection = {
  active: ProjectedGoal;
  completed: ProjectedGoal[];
};

type PieceRow = {
  id: string;
  kind: string;
  skill: string | null;
  local_day: string | null;
  payload_json: string;
  created_at: string;
};

function isPieceKind(kind: string): kind is PieceEventKind {
  return (PIECE_EVENT_KINDS as readonly string[]).includes(kind);
}

function payloadSource(payloadJson: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as { source?: unknown };
    return typeof payload.source === "string" ? payload.source : null;
  } catch {
    return null;
  }
}

export function pieceRole(kind: PieceEventKind, source: string | null): PieceRole {
  if (kind === "BadgeMilestone") return "badge";
  if (kind === "LevelUpSlight") return "level";
  if (source === "streak_hot") return "streak";
  return "build";
}

export function pieceCopyKey(role: PieceRole): InterfaceCopyKey {
  if (role === "badge") return "piece.badge";
  if (role === "level") return "piece.level";
  if (role === "streak") return "piece.streak";
  return "piece.build";
}

export function toProjectedPiece(row: PieceRow): ProjectedPiece {
  if (!isPieceKind(row.kind)) {
    throw new Error(`Qualifying event ${row.id} is not a build piece.`);
  }
  const role = pieceRole(row.kind, payloadSource(row.payload_json));
  return {
    eventId: row.id,
    kind: row.kind,
    role,
    copyKey: pieceCopyKey(role),
    skill: row.skill,
    localDay: row.local_day,
    createdAt: row.created_at,
  };
}

/** Places bus pieces onto the one active goal. Earlier goals are complete. */
export function projectBuildGoalFromPieces(
  pieces: readonly ProjectedPiece[],
): BuildGoalProjection {
  const completed: ProjectedGoal[] = [];
  let rest = pieces;
  for (let index = 0; index < BUILD_GOALS.length; index += 1) {
    const definition = BUILD_GOALS[index];
    const last = index === BUILD_GOALS.length - 1;
    const taken = last ? rest : rest.slice(0, definition.pieceTarget);
    rest = last ? [] : rest.slice(taken.length);
    const complete = taken.length >= definition.pieceTarget;
    const goal: ProjectedGoal = {
      id: definition.id,
      title: definition.title,
      pieceTarget: definition.pieceTarget,
      pieces: [...taken],
      complete,
      active: false,
    };
    if (!complete || last) {
      goal.active = true;
      return { active: goal, completed };
    }
    completed.push(goal);
  }
  throw new Error("Build goal projection did not choose an active goal.");
}

export function loadBuildPieces(db: Database.Database, childId: string): ProjectedPiece[] {
  const placeholders = PIECE_EVENT_KINDS.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, kind, skill, local_day, payload_json, created_at
       FROM qualifying_events
       WHERE child_id = ? AND kind IN (${placeholders})
       ORDER BY created_at ASC,
         CASE kind
           WHEN 'BadgeMilestone' THEN 0
           WHEN 'LevelUpSlight' THEN 1
           WHEN 'BuildPieceUnlock' THEN 2
           ELSE 3
         END ASC,
         id ASC`,
    )
    .all(childId, ...PIECE_EVENT_KINDS) as PieceRow[];
  return rows.map(toProjectedPiece);
}

export function projectBuildGoal(db: Database.Database, childId: string): BuildGoalProjection {
  const pieces = loadBuildPieces(db, childId);
  const projection = projectBuildGoalFromPieces(pieces);
  const placed = [
    ...projection.completed.flatMap((goal) => goal.pieces),
    ...projection.active.pieces,
  ];
  if (placed.length !== pieces.length) {
    throw new Error("Build goal dropped or duplicated a bus piece.");
  }
  const ids = new Set(placed.map((piece) => piece.eventId));
  if (ids.size !== placed.length) {
    throw new Error("Build goal reused a bus piece.");
  }
  const activeCount =
    projection.completed.filter((goal) => goal.active).length + (projection.active.active ? 1 : 0);
  if (activeCount !== 1) {
    throw new Error("A child must have one active build goal.");
  }
  return projection;
}
