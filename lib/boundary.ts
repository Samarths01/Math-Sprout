import type Database from "better-sqlite3";
import { DomainError, getChild } from "@/lib/domain";
import { catalogItem } from "@/lib/item-catalog";
import {
  evidenceForSkill,
  readPracticeSession,
  readSkillClientView,
  setNextLane,
  skillsShortOfGotIt,
  type PracticeSessionRow,
} from "@/lib/learner-state";
import {
  mintLevelUpSlight,
  observeStreak,
  readChildTimeZone,
  reviewSessionsRemaining,
} from "@/lib/qualifying-bus";
import {
  MasteryEstimator,
  practiceLaneOrRecommended,
  type BoundaryLaneOption,
  type BoundaryOptions,
  type PracticeLane,
} from "@/lib/mastery";
import { practiceGate } from "@/lib/practice-gate";

const LANE_LABEL: Record<PracticeLane, BoundaryLaneOption["label"]> = {
  recommended: "Recommended",
  challenge: "Challenge",
  review: "Review",
};

function nowIso(): string {
  return new Date().toISOString();
}

function assertPracticeAllowed(db: Database.Database, guardianId: string, childId: string) {
  const child = getChild(db, guardianId, childId);
  const gate = practiceGate(child.consentStatus);
  if (!gate.practiceAllowed) {
    throw new DomainError(
      gate.reason ?? "Practice is blocked until a parent grants consent.",
      403,
    );
  }
}

function requireSession(
  db: Database.Database,
  childId: string,
  sessionId: string,
): PracticeSessionRow {
  const session = readPracticeSession(db, childId, sessionId);
  if (!session) throw new DomainError("Practice session not found.", 404);
  return session;
}

function focusSkill(db: Database.Database, sessionId: string): string {
  const row = db
    .prepare(
      `SELECT item_id FROM attempts
       WHERE session_id = ?
       ORDER BY submitted_at DESC, created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(sessionId) as { item_id: string } | undefined;
  const skill = row ? catalogItem(row.item_id)?.skill : undefined;
  if (!skill) throw new DomainError("Finish one problem before ending this session.", 400);
  return skill;
}

function boundaryOptions(
  db: Database.Database,
  session: PracticeSessionRow,
  childId: string,
): BoundaryOptions {
  if (session.phase !== "boundary" || !session.progression) {
    throw new DomainError("Lane choice waits until this session ends.", 409);
  }
  const skill = focusSkill(db, session.id);
  const clientView = readSkillClientView(db, childId, skill);
  if (!clientView) {
    throw new DomainError("Learner state for this session is missing.", 500);
  }
  const remaining = skillsShortOfGotIt(db, childId);
  const sessionsRemaining = reviewSessionsRemaining(
    db,
    childId,
    readChildTimeZone(db, childId),
    nowIso(),
  );
  const options: BoundaryLaneOption[] = [
    {
      lane: "recommended",
      label: LANE_LABEL.recommended,
      isDefault: true,
      available: true,
    },
    {
      lane: "challenge",
      label: LANE_LABEL.challenge,
      isDefault: false,
      available: true,
    },
  ];
  if (remaining.length > 0) {
    options.push({
      lane: "review",
      label: LANE_LABEL.review,
      isDefault: false,
      available: sessionsRemaining > 0,
      remaining: remaining.length,
      sessionsRemaining,
    });
  }
  return {
    sessionId: session.id,
    atBoundary: true,
    boundary: "session",
    defaultLane: "recommended",
    progression: session.progression,
    levelUpSlight: session.progression === "levelUpSlight",
    focusSkill: skill,
    clientView,
    reviewSessionsRemaining: sessionsRemaining,
    options,
  };
}

/**
 * SessionBoundary. SetBoundary is deferred. Calling this again does not
 * mint a second LevelUpSlight.
 */
export function endPracticeSession(
  db: Database.Database,
  guardianId: string,
  childId: string,
  sessionId: string,
): BoundaryOptions {
  assertPracticeAllowed(db, guardianId, childId);
  const commit = db.transaction(() => {
    observeStreak(db, childId, readChildTimeZone(db, childId), nowIso());
    const session = requireSession(db, childId, sessionId);
    if (session.phase === "closed") {
      throw new DomainError("That session is already closed.", 409);
    }
    if (session.phase === "boundary") return boundaryOptions(db, session, childId);

    const skill = focusSkill(db, session.id);
    const evidence = evidenceForSkill(db, childId, skill);
    const progression = new MasteryEstimator().decideProgression(evidence);
    if (progression === "levelUpSlight") {
      mintLevelUpSlight(db, {
        childId,
        sessionId: session.id,
        practiceLane: session.practice_lane,
        createdAt: nowIso(),
        timeZone: readChildTimeZone(db, childId),
      });
    }
    db.prepare(
      `UPDATE practice_sessions SET phase = 'boundary', progression = ? WHERE id = ?`,
    ).run(progression, session.id);
    const ended = requireSession(db, childId, sessionId);
    return boundaryOptions(db, ended, childId);
  });
  return commit.immediate();
}

export function getBoundaryOptions(
  db: Database.Database,
  guardianId: string,
  childId: string,
  sessionId: string,
): BoundaryOptions {
  assertPracticeAllowed(db, guardianId, childId);
  const session = requireSession(db, childId, sessionId);
  if (session.phase === "closed") {
    throw new DomainError("That session is already closed.", 409);
  }
  return boundaryOptions(db, session, childId);
}

export function parseLaneChoice(value: unknown): PracticeLane {
  return practiceLaneOrRecommended(value);
}

export function choosePracticeLane(
  db: Database.Database,
  guardianId: string,
  childId: string,
  sessionId: string,
  lane: PracticeLane,
): { sessionId: string; lane: PracticeLane } {
  assertPracticeAllowed(db, guardianId, childId);
  const commit = db.transaction(() => {
    const session = requireSession(db, childId, sessionId);
    if (session.phase === "closed") {
      throw new DomainError("That session is already closed.", 409);
    }
    const options = boundaryOptions(db, session, childId);
    if (
      lane === "review" &&
      options.reviewSessionsRemaining <= 0 &&
      options.options.some((option) => option.lane === "review")
    ) {
      throw new DomainError("Review sets for this week are used up.", 400);
    }
    const choice = options.options.find((option) => option.lane === lane && option.available);
    if (!choice) {
      throw new DomainError("Review is for skills that are still left.", 400);
    }
    setNextLane(db, childId, lane);
    db.prepare(`UPDATE practice_sessions SET phase = 'closed' WHERE id = ?`).run(session.id);
    return { sessionId: session.id, lane };
  });
  return commit.immediate();
}
