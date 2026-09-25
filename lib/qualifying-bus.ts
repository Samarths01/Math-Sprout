import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  resolveCelebration,
  XP_AMOUNT,
  type BandLabel,
  type CelebrationTier,
  type ClientView,
  type IntegrityFlag,
  type ReviewLane,
} from "@/lib/attempt-contract";
import {
  QUALIFYING_DAY_MIN_HONEST_ATTEMPTS,
  REVIEW_SESSIONS_PER_WEEK,
} from "@/lib/economy-config";
import { DomainError } from "@/lib/domain";
import { loadQualifyingDays, projectHeat } from "@/lib/fuel";
import { bumpDifficulty, ensureLearnerProgress } from "@/lib/learner-state";
import { calendarDaysBetween, localDate, localWeekRange } from "@/lib/local-time";
import { MasteryEstimator, assessWindow, type PracticeLane, type SkillEvidence } from "@/lib/mastery";
import { POLICY_VERSION } from "@/lib/policy";
import { emptyStreak, type StreakRecord, type StreakState } from "@/lib/streak";

export const QUALIFYING_EVENT_KINDS = [
  "HonestAttempt",
  "ConceptProgressTick",
  "MasteryBandTransition",
  "LevelUpSlight",
  "QualifyingPracticeDay",
  "BadgeMilestone",
  "BuildPieceUnlock",
] as const;

export type QualifyingEventKind = (typeof QUALIFYING_EVENT_KINDS)[number];

export type PlannedMint = {
  kind: QualifyingEventKind;
  idempotencyKey: string;
  xpAmount: number;
  celebrationTier: "quietXp" | "full" | null;
  qualifies: boolean;
  skill: string | null;
  localDay: string | null;
  payload: Record<string, string | boolean | number | null>;
};

const REVIEW_MINT_KINDS = new Set<QualifyingEventKind>(["HonestAttempt"]);

export type AttemptEconomy = {
  lane: ReviewLane;
  celebrationTier: CelebrationTier;
  mints: PlannedMint[];
  clientView: ClientView;
};

type GateInput = {
  practiceLane: PracticeLane;
  integrityLane: ReviewLane;
  reviewSessionsThisWeek: number;
};

export function readChildTimeZone(db: Database.Database, childId: string): string {
  const row = db
    .prepare(`SELECT timezone FROM children WHERE id = ?`)
    .get(childId) as { timezone: string } | undefined;
  if (!row?.timezone) throw new DomainError("Child timezone is missing.", 500);
  return row.timezone;
}

export function reviewAllowsKind(practiceLane: PracticeLane, kind: QualifyingEventKind): boolean {
  if (practiceLane !== "review") return true;
  return REVIEW_MINT_KINDS.has(kind);
}

/**
 * Mint gate. Review over the weekly cap drops every mint.
 * Review (practice lane or integrity lane) keeps a reduced HonestAttempt only.
 */
export function applyMintGate(mints: readonly PlannedMint[], input: GateInput): PlannedMint[] {
  if (
    input.practiceLane === "review" &&
    input.reviewSessionsThisWeek > REVIEW_SESSIONS_PER_WEEK
  ) {
    return [];
  }
  const reduced =
    input.practiceLane === "review" || input.integrityLane === "review";
  const gated: PlannedMint[] = [];
  for (const mint of mints) {
    if (reduced && !REVIEW_MINT_KINDS.has(mint.kind)) continue;
    if (reduced && mint.celebrationTier === "full") {
      gated.push({
        ...mint,
        celebrationTier: "quietXp",
        xpAmount: XP_AMOUNT.quietXp,
      });
      continue;
    }
    gated.push(mint);
  }
  return gated;
}

/** celebrationTier comes only from the mints in this transaction. */
export function deriveCelebration(
  mints: readonly PlannedMint[],
  integrityLane: ReviewLane,
): CelebrationTier {
  const credits = mints.filter((mint) => mint.xpAmount > 0);
  if (credits.length === 0) return "none";
  if (credits.some((mint) => mint.celebrationTier === "full")) {
    if (integrityLane === "review") throw new Error("Review lane cannot mint full.");
    return "full";
  }
  return "quietXp";
}

export function assertCelebrationBacked(input: {
  tier: CelebrationTier;
  xpCount: number;
  integrityLane: ReviewLane;
  practiceLane: PracticeLane;
}): void {
  if (input.tier === "full" && input.xpCount < 1) {
    throw new Error("full celebration requires a mint.");
  }
  if (
    (input.integrityLane === "review" || input.practiceLane === "review") &&
    input.tier === "full"
  ) {
    throw new Error("Review lane cannot mint full.");
  }
  if (input.tier === "quietXp" && input.xpCount < 1) {
    throw new Error("quietXp celebration requires a mint.");
  }
}

export function countReviewSessions(
  db: Database.Database,
  childId: string,
  timeZone: string,
  anchorIso: string,
): number {
  const week = localWeekRange(anchorIso, timeZone);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM practice_sessions
       WHERE child_id = ? AND practice_lane = 'review'
         AND started_at >= ? AND started_at < ?`,
    )
    .get(childId, week.startIso, week.endIso) as { count: number };
  return row.count;
}

export function reviewSessionsRemaining(
  db: Database.Database,
  childId: string,
  timeZone: string,
  nowIso: string,
): number {
  return Math.max(0, REVIEW_SESSIONS_PER_WEEK - countReviewSessions(db, childId, timeZone, nowIso));
}

function sessionStartedAt(db: Database.Database, sessionId: string): string {
  const row = db
    .prepare(`SELECT started_at FROM practice_sessions WHERE id = ?`)
    .get(sessionId) as { started_at: string } | undefined;
  if (!row) throw new DomainError("Practice session not found.", 404);
  return row.started_at;
}

function honestAttemptsOnDay(db: Database.Database, childId: string, localDay: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM qualifying_events
       WHERE child_id = ? AND kind = 'HonestAttempt' AND qualifies = 1 AND local_day = ?`,
    )
    .get(childId, localDay) as { count: number };
  return row.count;
}

function attemptReason(
  flags: readonly IntegrityFlag[],
  correct: boolean,
  practiceLane: PracticeLane,
): string {
  if (flags.includes("spam_window")) return "spam_window";
  if (practiceLane === "review") return "review_lane";
  return correct ? "careful_correct" : "careful_miss";
}

function bandMoved(previous: BandLabel | null, next: BandLabel): boolean {
  if (previous === next) return false;
  if (previous === null && next === "Still learning") return false;
  return true;
}

function gateInputFor(
  db: Database.Database,
  childId: string,
  sessionId: string,
  timeZone: string,
  practiceLane: PracticeLane,
  integrityLane: ReviewLane,
): GateInput {
  return {
    practiceLane,
    integrityLane,
    reviewSessionsThisWeek: countReviewSessions(
      db,
      childId,
      timeZone,
      sessionStartedAt(db, sessionId),
    ),
  };
}

/** Band view for a non-evidence attempt when this skill has no saved view yet. */
function emptyClientView(): ClientView {
  return {
    bandLabel: assessWindow([]).bandLabel,
    showConceptChip: false,
    celebrationTier: "none",
  };
}

export function planAttemptEconomy(
  db: Database.Database,
  input: {
    childId: string;
    sessionId: string;
    idempotencyKey: string;
    timeZone: string;
    submittedAt: string;
    skill: string;
    correct: boolean;
    flags: readonly IntegrityFlag[];
    practiceLane: PracticeLane;
    history: readonly SkillEvidence[];
    previousBand: BandLabel | null;
    /**
     * False for a non-evidence attempt. The saved band view is returned as-is,
     * and nothing that depends on evidence is minted.
     */
    countsForBand?: boolean;
    savedClientView?: ClientView | null;
  },
): AttemptEconomy {
  const integrity = resolveCelebration({ correct: input.correct, flags: input.flags });
  const gate = gateInputFor(
    db,
    input.childId,
    input.sessionId,
    input.timeZone,
    input.practiceLane,
    integrity.lane,
  );
  const day = localDate(input.submittedAt, input.timeZone);
  const overCap =
    input.practiceLane === "review" &&
    gate.reviewSessionsThisWeek > REVIEW_SESSIONS_PER_WEEK;
  const qualifies = integrity.lane === "celebrate" && input.practiceLane !== "review" && !overCap;
  const mints: PlannedMint[] = [];
  if (integrity.xpAmount > 0 && !overCap) {
    const celebrationTier: "quietXp" | "full" =
      input.practiceLane === "review" || integrity.celebrationTier !== "full"
        ? "quietXp"
        : "full";
    mints.push({
      kind: "HonestAttempt",
      idempotencyKey: `${input.idempotencyKey}:HonestAttempt`,
      xpAmount: XP_AMOUNT[celebrationTier],
      celebrationTier,
      qualifies,
      skill: input.skill,
      localDay: day,
      payload: {
        practiceLane: input.practiceLane,
        reduced: celebrationTier !== "full",
        reason: attemptReason(input.flags, input.correct, input.practiceLane),
      },
    });
    if (qualifies && input.correct && input.countsForBand !== false) {
      mints.push({
        kind: "ConceptProgressTick",
        idempotencyKey: `${input.idempotencyKey}:ConceptProgressTick`,
        xpAmount: 0,
        celebrationTier: null,
        qualifies: false,
        skill: input.skill,
        localDay: day,
        payload: { practiceLane: input.practiceLane },
      });
    }
    if (qualifies && honestAttemptsOnDay(db, input.childId, day) + 1 >= QUALIFYING_DAY_MIN_HONEST_ATTEMPTS) {
      mints.push({
        kind: "QualifyingPracticeDay",
        idempotencyKey: `day:${day}:QualifyingPracticeDay`,
        xpAmount: 0,
        celebrationTier: null,
        qualifies: false,
        skill: null,
        localDay: day,
        payload: { source: "honest_attempts" },
      });
    }
  }

  const estimator = new MasteryEstimator();
  if (estimator.policyVersion !== POLICY_VERSION) {
    throw new DomainError("Estimator policy_version is missing.", 500);
  }
  const gated = applyMintGate(mints, gate);
  const celebrationTier = deriveCelebration(gated, integrity.lane);
  assertCelebrationBacked({
    tier: celebrationTier,
    xpCount: gated.filter((mint) => mint.xpAmount > 0).length,
    integrityLane: integrity.lane,
    practiceLane: input.practiceLane,
  });
  const countsForBand = input.countsForBand !== false;
  const clientView = countsForBand
    ? estimator.toClientView({
        correct: input.correct,
        lane: integrity.lane,
        celebrationTier,
        practiceLane: input.practiceLane,
        history: input.history,
      })
    : (input.savedClientView ?? emptyClientView());

  const withBands = [...gated];
  if (countsForBand && bandMoved(input.previousBand, clientView.bandLabel)) {
    withBands.push({
      kind: "MasteryBandTransition",
      idempotencyKey: `${input.idempotencyKey}:MasteryBandTransition`,
      xpAmount: 0,
      celebrationTier: null,
      qualifies: false,
      skill: input.skill,
      localDay: day,
      payload: {
        from: input.previousBand,
        to: clientView.bandLabel,
      },
    });
  }
  if (
    countsForBand &&
    clientView.bandLabel === "Got it" &&
    input.previousBand !== "Got it"
  ) {
    withBands.push({
      kind: "BadgeMilestone",
      idempotencyKey: `badge:${input.skill}:Got it`,
      xpAmount: 0,
      celebrationTier: null,
      qualifies: false,
      skill: input.skill,
      localDay: day,
      payload: { band: "Got it" },
    });
  }
  const finalMints = applyMintGate(withBands, gate);
  const finalTier = deriveCelebration(finalMints, integrity.lane);
  if (finalTier !== celebrationTier) {
    throw new Error("celebrationTier drifted from minted events.");
  }
  assertCelebrationBacked({
    tier: finalTier,
    xpCount: finalMints.filter((mint) => mint.xpAmount > 0).length,
    integrityLane: integrity.lane,
    practiceLane: input.practiceLane,
  });
  return {
    lane: integrity.lane,
    celebrationTier: finalTier,
    mints: finalMints,
    clientView,
  };
}

function appendEvent(
  db: Database.Database,
  input: {
    childId: string;
    attemptId: string | null;
    sessionId: string | null;
    createdAt: string;
    mint: PlannedMint;
  },
): { id: string; inserted: boolean } {
  const existing = db
    .prepare(
      `SELECT id FROM qualifying_events WHERE child_id = ? AND idempotency_key = ?`,
    )
    .get(input.childId, input.mint.idempotencyKey) as { id: string } | undefined;
  if (existing) return { id: existing.id, inserted: false };
  const id = randomUUID();
  db.prepare(
    `INSERT INTO qualifying_events (
       id, child_id, kind, idempotency_key, attempt_id, session_id, skill,
       local_day, qualifies, payload_json, created_at
     ) VALUES (
       @id, @child_id, @kind, @idempotency_key, @attempt_id, @session_id, @skill,
       @local_day, @qualifies, @payload_json, @created_at
     )`,
  ).run({
    id,
    child_id: input.childId,
    kind: input.mint.kind,
    idempotency_key: input.mint.idempotencyKey,
    attempt_id: input.attemptId,
    session_id: input.sessionId,
    skill: input.mint.skill,
    local_day: input.mint.localDay,
    qualifies: input.mint.qualifies ? 1 : 0,
    payload_json: JSON.stringify(input.mint.payload),
    created_at: input.createdAt,
  });
  return { id, inserted: true };
}

function asStreakState(value: string | null): StreakState {
  if (value === "hot" || value === "warm" || value === "ember" || value === "dormant") {
    return value;
  }
  return "dormant";
}

export function readStreak(db: Database.Database, childId: string): StreakRecord {
  ensureLearnerProgress(db, childId);
  const row = db
    .prepare(
      `SELECT streak_state, ember_expires_at, last_qualifying_day
       FROM learner_progress WHERE child_id = ?`,
    )
    .get(childId) as
    | {
        streak_state: string | null;
        ember_expires_at: string | null;
        last_qualifying_day: string | null;
      }
    | undefined;
  if (!row) return emptyStreak();
  return {
    state: asStreakState(row.streak_state),
    emberExpiresAt: row.ember_expires_at,
    lastQualifyingDay: row.last_qualifying_day,
  };
}

function writeStreak(db: Database.Database, childId: string, record: StreakRecord): void {
  ensureLearnerProgress(db, childId);
  db.prepare(
    `UPDATE learner_progress
     SET streak_state = ?, ember_expires_at = ?, last_qualifying_day = ?, updated_at = ?
     WHERE child_id = ?`,
  ).run(
    record.state,
    record.emberExpiresAt,
    record.lastQualifyingDay,
    new Date().toISOString(),
    childId,
  );
}

function persistStreak(
  db: Database.Database,
  childId: string,
  timeZone: string,
  input: { eventAt: string; observedAt: string; qualify: boolean },
): { record: StreakRecord; becameHot: boolean; qualifyingDay: string } {
  const eventDay = localDate(input.eventAt, timeZone);
  const days = loadQualifyingDays(db, childId);
  const projected = projectHeat(days, timeZone, input.observedAt);
  const priorDays = input.qualify ? days.filter((day) => day.localDay !== eventDay) : days;
  const prior = projectHeat(priorDays, timeZone, input.observedAt);
  const becameHot = input.qualify && projected.state === "hot" && prior.state !== "hot";
  const record: StreakRecord = {
    state: projected.state,
    emberExpiresAt: projected.emberExpiresAt,
    lastQualifyingDay: projected.lastQualifyingDay,
  };
  writeStreak(db, childId, record);
  return { record, becameHot, qualifyingDay: eventDay };
}

export function observeStreak(
  db: Database.Database,
  childId: string,
  timeZone: string,
  observedAt: string,
): StreakRecord {
  return persistStreak(db, childId, timeZone, {
    eventAt: observedAt,
    observedAt,
    qualify: false,
  }).record;
}

function mintHotPiece(
  db: Database.Database,
  input: {
    childId: string;
    attemptId: string;
    sessionId: string;
    qualifyingDay: string;
    becameHot: boolean;
    practiceLane: PracticeLane;
    createdAt: string;
  },
): void {
  if (!input.becameHot) return;
  if (!reviewAllowsKind(input.practiceLane, "BuildPieceUnlock")) return;
  const prior = db
    .prepare(
      `SELECT local_day FROM qualifying_events
       WHERE child_id = ? AND kind = 'BuildPieceUnlock' AND idempotency_key LIKE 'streak-hot:%'
       ORDER BY local_day DESC LIMIT 1`,
    )
    .get(input.childId) as { local_day: string | null } | undefined;
  if (prior?.local_day && calendarDaysBetween(prior.local_day, input.qualifyingDay) <= 1) {
    return;
  }
  appendEvent(db, {
    childId: input.childId,
    attemptId: input.attemptId,
    sessionId: input.sessionId,
    createdAt: input.createdAt,
    mint: {
      kind: "BuildPieceUnlock",
      idempotencyKey: `streak-hot:${input.qualifyingDay}`,
      xpAmount: 0,
      celebrationTier: null,
      qualifies: false,
      skill: null,
      localDay: input.qualifyingDay,
      payload: { source: "streak_hot" },
    },
  });
}

export function commitAttemptEconomy(
  db: Database.Database,
  input: {
    childId: string;
    attemptId: string;
    sessionId: string;
    timeZone: string;
    submittedAt: string;
    observedAt: string;
    createdAt: string;
    practiceLane: PracticeLane;
    integrityLane: ReviewLane;
    celebrationTier: CelebrationTier;
    mints: readonly PlannedMint[];
  },
): void {
  const gate = gateInputFor(
    db,
    input.childId,
    input.sessionId,
    input.timeZone,
    input.practiceLane,
    input.integrityLane,
  );
  const gated = applyMintGate(input.mints, gate);
  const derived = deriveCelebration(gated, input.integrityLane);
  if (derived !== input.celebrationTier) {
    throw new Error("celebrationTier drifted from minted events.");
  }
  let dayInserted = false;
  let xpInserted = 0;
  for (const mint of gated) {
    const event = appendEvent(db, {
      childId: input.childId,
      attemptId: input.attemptId,
      sessionId: input.sessionId,
      createdAt: input.createdAt,
      mint,
    });
    if (mint.kind === "QualifyingPracticeDay" && event.inserted) dayInserted = true;
    if (mint.xpAmount > 0 && event.inserted) {
      if (mint.celebrationTier !== "quietXp" && mint.celebrationTier !== "full") {
        throw new Error("XP credit is missing a celebration tier.");
      }
      db.prepare(
        `INSERT INTO xp_events (
           id, attempt_id, child_id, amount, celebration_tier, minted_at, qualifying_event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.attemptId,
        input.childId,
        mint.xpAmount,
        mint.celebrationTier,
        input.createdAt,
        event.id,
      );
      xpInserted += 1;
    }
  }
  assertCelebrationBacked({
    tier: derived,
    xpCount: xpInserted,
    integrityLane: input.integrityLane,
    practiceLane: input.practiceLane,
  });
  const streak = persistStreak(db, input.childId, input.timeZone, {
    eventAt: input.submittedAt,
    observedAt: input.observedAt,
    qualify: dayInserted,
  });
  mintHotPiece(db, {
    childId: input.childId,
    attemptId: input.attemptId,
    sessionId: input.sessionId,
    qualifyingDay: streak.qualifyingDay,
    becameHot: streak.becameHot,
    practiceLane: input.practiceLane,
    createdAt: input.createdAt,
  });
}

/**
 * LevelUpSlight and its build piece. Review never mints either.
 * `boundary_events` stays the session projection Slice 3 already counts.
 */
export function mintLevelUpSlight(
  db: Database.Database,
  input: {
    childId: string;
    sessionId: string;
    practiceLane: PracticeLane;
    createdAt: string;
    timeZone: string;
  },
): boolean {
  if (!reviewAllowsKind(input.practiceLane, "LevelUpSlight")) return false;
  const existing = db
    .prepare(`SELECT id FROM boundary_events WHERE session_id = ?`)
    .get(input.sessionId) as { id: string } | undefined;
  const event = appendEvent(db, {
    childId: input.childId,
    attemptId: null,
    sessionId: input.sessionId,
    createdAt: input.createdAt,
    mint: {
      kind: "LevelUpSlight",
      idempotencyKey: `session:${input.sessionId}:LevelUpSlight`,
      xpAmount: 0,
      celebrationTier: null,
      qualifies: false,
      skill: null,
      localDay: localDate(input.createdAt, input.timeZone),
      payload: { practiceLane: input.practiceLane },
    },
  });
  if (!existing) {
    db.prepare(
      `INSERT INTO boundary_events (id, child_id, session_id, kind, created_at)
       VALUES (?, ?, ?, 'level_up_slight', ?)`,
    ).run(randomUUID(), input.childId, input.sessionId, input.createdAt);
    bumpDifficulty(db, input.childId);
  }
  if (reviewAllowsKind(input.practiceLane, "BuildPieceUnlock")) {
    appendEvent(db, {
      childId: input.childId,
      attemptId: null,
      sessionId: input.sessionId,
      createdAt: input.createdAt,
      mint: {
        kind: "BuildPieceUnlock",
        idempotencyKey: `session:${input.sessionId}:BuildPieceUnlock`,
        xpAmount: 0,
        celebrationTier: null,
        qualifies: false,
        skill: null,
        localDay: localDate(input.createdAt, input.timeZone),
        payload: { source: "level_up_slight" },
      },
    });
  }
  return event.inserted && !existing;
}
