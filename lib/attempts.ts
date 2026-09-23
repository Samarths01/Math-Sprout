import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  FOUR_BEAT_KEYS,
  integrityFlags,
  type AttemptResult,
  type FourBeat,
  type IntegrityFlag,
  type BandLabel,
  type ClientView,
  SPAM_WINDOW_MS,
} from "@/lib/attempt-contract";
import { buildFourBeat } from "@/lib/beats";
import { consentDenied, DomainError, getChild } from "@/lib/domain";
import { catalogItem, itemAt, ITEM_CATALOG } from "@/lib/item-catalog";
import {
  assertBankMatchesCatalog,
  canonicalAnswer,
  gradeAnswer,
  knownItem,
} from "@/lib/item-bank";
import {
  ensureLearnerProgress,
  evidenceForSkill,
  firstReviewSkill,
  readPracticeSession,
  readSkillClientView,
  saveSkillState,
  startIndexForLane,
} from "@/lib/learner-state";
import type { PracticeLane } from "@/lib/mastery";
import {
  commitAttemptEconomy,
  observeStreak,
  planAttemptEconomy,
  readChildTimeZone,
} from "@/lib/qualifying-bus";
import { readAttemptLog } from "@/lib/attempt-log";
import { fuelFromEvents } from "@/lib/fuel";
import { POLICY_VERSION } from "@/lib/policy";
import { takePendingPauseHold } from "@/lib/pause-hold";
import { practiceGate } from "@/lib/practice-gate";

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

export type SubmitAttemptInput = {
  idempotencyKey: string;
  sessionId: string;
  itemId: string;
  answer: string;
  shownAt: string;
  submittedAt: string;
};

export type PracticeSessionStart = {
  sessionId: string;
  item: AttemptResult["nextItem"];
  lane: PracticeLane;
  atBoundary: boolean;
  clientView: ClientView | null;
};

type AttemptRow = {
  id: string;
  child_id: string;
  session_id: string;
  idempotency_key: string;
  item_id: string;
  answer: string;
  correct: number;
  lane: AttemptResult["lane"];
  celebration_tier: AttemptResult["celebrationTier"];
  flags_json: string;
  beats_json: string;
  client_view_json: string;
  resume_presentation: "live" | "quiet";
};

assertBankMatchesCatalog();

function nowIso(): string {
  return new Date().toISOString();
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String((error as { code?: string }).code).includes("SQLITE_CONSTRAINT")
  );
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError(`${label} is required.`, 400);
  }
  return value.trim();
}

function parseInstant(value: string, label: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new DomainError(`${label} must be a valid time.`, 400);
  }
  return new Date(ms).toISOString();
}

export function parseSubmitAttempt(
  body: Record<string, unknown>,
): SubmitAttemptInput {
  const idempotencyKey = requireText(body.idempotencyKey, "Idempotency key");
  if (!KEY_PATTERN.test(idempotencyKey)) {
    throw new DomainError(
      "Idempotency key must be 8–80 letters, numbers, underscores, or hyphens.",
      400,
    );
  }
  if (typeof body.answer !== "string") {
    throw new DomainError("Answer must be a string.", 400);
  }
  if (body.answer.length > 80) {
    throw new DomainError("Answer is too long.", 400);
  }
  const shownAt = requireText(body.shownAt, "Shown time");
  const submittedAt = requireText(body.submittedAt, "Submitted time");
  return {
    idempotencyKey,
    sessionId: requireText(body.sessionId, "Session"),
    itemId: requireText(body.itemId, "Problem"),
    answer: body.answer,
    shownAt,
    submittedAt,
  };
}

function requireSession(db: Database.Database, childId: string, sessionId: string) {
  const row = readPracticeSession(db, childId, sessionId);
  if (!row) throw new DomainError("Practice session not found.", 404);
  return row;
}

function presentSession(
  db: Database.Database,
  childId: string,
  session: {
    id: string;
    item_index: number;
    practice_lane: PracticeLane;
    phase: "practicing" | "boundary" | "closed";
  },
): PracticeSessionStart {
  const item = itemAt(session.item_index);
  return {
    sessionId: session.id,
    item,
    lane: session.practice_lane,
    atBoundary: session.phase === "boundary",
    clientView: readSkillClientView(db, childId, item.skill),
  };
}

function findAttempt(
  db: Database.Database,
  childId: string,
  idempotencyKey: string,
): AttemptRow | undefined {
  return db
    .prepare(
      `SELECT id, child_id, session_id, idempotency_key, item_id, answer, correct,
              lane, celebration_tier, flags_json, beats_json, client_view_json,
              resume_presentation
       FROM attempts
       WHERE child_id = ? AND idempotency_key = ?`,
    )
    .get(childId, idempotencyKey) as AttemptRow | undefined;
}

function readBeats(raw: string): FourBeat {
  const parsed = JSON.parse(raw) as Partial<FourBeat>;
  const beats = {} as FourBeat;
  for (const key of FOUR_BEAT_KEYS) {
    const value = parsed[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new DomainError("Stored attempt feedback is incomplete.", 500);
    }
    beats[key] = value;
  }
  return beats;
}

function readClientView(
  raw: string,
  celebrationTier: AttemptResult["celebrationTier"],
): ClientView {
  const parsed = JSON.parse(raw) as Partial<ClientView> & { softState?: string };
  const locked = ["Still learning", "Getting it", "Got it"] as const;
  const bandLabel: BandLabel = locked.includes(parsed.bandLabel as BandLabel)
    ? (parsed.bandLabel as BandLabel)
    : parsed.softState === "steady"
      ? "Getting it"
      : "Still learning";
  const showConceptChip =
    typeof parsed.showConceptChip === "boolean"
      ? parsed.showConceptChip
      : parsed.softState !== "needs-review";
  return { bandLabel, showConceptChip, celebrationTier };
}

function resultFromRow(
  db: Database.Database,
  row: AttemptRow,
  replayed: boolean,
): AttemptResult {
  const credits = db
    .prepare(
      `SELECT amount FROM xp_events WHERE attempt_id = ? ORDER BY minted_at ASC, id ASC`,
    )
    .all(row.id) as Array<{ amount: number }>;
  const qualifying = db
    .prepare(
      `SELECT id, kind FROM qualifying_events WHERE attempt_id = ? ORDER BY rowid ASC`,
    )
    .all(row.id) as Array<{ id: string; kind: string }>;
  const credit = credits.reduce((sum, event) => sum + event.amount, 0);
  const session = db
    .prepare(`SELECT item_index FROM practice_sessions WHERE id = ?`)
    .get(row.session_id) as { item_index: number } | undefined;
  if (!session) throw new DomainError("Practice session not found.", 404);
  const beats = readBeats(row.beats_json);
  if (row.celebration_tier === "full" && credits.length === 0) {
    throw new DomainError("full celebration requires a mint.", 500);
  }
  if (row.celebration_tier === "quietXp" && credits.length === 0) {
    throw new DomainError("quietXp celebration requires a mint.", 500);
  }
  const clientView = readClientView(row.client_view_json, row.celebration_tier);
  const flags = JSON.parse(row.flags_json) as IntegrityFlag[];
  return {
    attemptId: row.id,
    idempotencyKey: row.idempotency_key,
    replayed,
    correct: row.correct === 1,
    ...beats,
    celebrationTier: row.celebration_tier,
    lane: row.lane,
    flags,
    eventIds: qualifying.map((event) => event.id),
    xpAmount: credit,
    fuel: fuelFromEvents(qualifying, credit),
    clientView,
    nextItem: itemAt(session.item_index),
    ...(row.resume_presentation === "quiet" ? { resumePresentation: "quiet" as const } : {}),
  };
}

export function startPracticeSession(
  db: Database.Database,
  guardianId: string,
  childId: string,
): PracticeSessionStart {
  const child = getChild(db, guardianId, childId);
  const gate = practiceGate(child.consentStatus);
  if (!gate.practiceAllowed) throw consentDenied(child.consentStatus);
  const open = db.transaction(() => {
    observeStreak(db, childId, readChildTimeZone(db, childId), nowIso());
    const practicing = db
      .prepare(
        `SELECT id FROM practice_sessions
         WHERE child_id = ? AND status = 'active' AND phase = 'practicing'
         ORDER BY started_at ASC
         LIMIT 1`,
      )
      .get(childId) as { id: string } | undefined;
    if (practicing) {
      const session = readPracticeSession(db, childId, practicing.id);
      if (!session) throw new DomainError("Practice session not found.", 404);
      return session;
    }
    const pendingBoundary = db
      .prepare(
        `SELECT id FROM practice_sessions
         WHERE child_id = ? AND status = 'active' AND phase = 'boundary'
         ORDER BY started_at ASC
         LIMIT 1`,
      )
      .get(childId) as { id: string } | undefined;
    if (pendingBoundary) {
      const session = readPracticeSession(db, childId, pendingBoundary.id);
      if (!session) throw new DomainError("Practice session not found.", 404);
      return session;
    }
    const progress = ensureLearnerProgress(db, childId);
    const reviewSkill =
      progress.nextLane === "review" ? firstReviewSkill(db, childId) : null;
    const itemIndex = startIndexForLane(
      progress.nextLane,
      progress.difficultyStep,
      reviewSkill,
    );
    const sessionId = randomUUID();
    db.prepare(
      `INSERT INTO practice_sessions (
         id, child_id, status, item_index, started_at, practice_lane, phase,
         policy_version
       ) VALUES (?, ?, 'active', ?, ?, ?, 'practicing', ?)`,
    ).run(sessionId, childId, itemIndex, nowIso(), progress.nextLane, POLICY_VERSION);
    const created = readPracticeSession(db, childId, sessionId);
    if (!created) throw new DomainError("Practice session was not saved.", 500);
    return created;
  });
  return presentSession(db, childId, open.immediate());
}

export function submitAttempt(
  db: Database.Database,
  guardianId: string,
  childId: string,
  input: SubmitAttemptInput,
  options?: { now?: string },
): AttemptResult {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!KEY_PATTERN.test(idempotencyKey)) {
    throw new DomainError(
      "Idempotency key must be 8–80 letters, numbers, underscores, or hyphens.",
      400,
    );
  }
  if (typeof input.answer !== "string" || input.answer.length > 80) {
    throw new DomainError("Answer must be a string up to 80 characters.", 400);
  }
  const shownAt = parseInstant(input.shownAt, "Shown time");
  const submittedAt = parseInstant(input.submittedAt, "Submitted time");
  const sessionId = input.sessionId.trim();
  const itemId = input.itemId.trim();
  getChild(db, guardianId, childId);
  requireSession(db, childId, sessionId);
  if (!knownItem(itemId)) {
    throw new DomainError("That problem is not in this practice pack.", 400);
  }

  const commit = db.transaction(() => {
    const existing = findAttempt(db, childId, idempotencyKey);
    if (existing) return resultFromRow(db, existing, true);

    const child = getChild(db, guardianId, childId);
    const gate = practiceGate(child.consentStatus);
    if (!gate.practiceAllowed) throw consentDenied(child.consentStatus);
    const session = requireSession(db, childId, sessionId);
    if (session.phase !== "practicing") {
      throw new DomainError(
        "This session has ended. Choose a lane to start the next one.",
        409,
      );
    }
    const item = catalogItem(itemId);
    if (!item) throw new DomainError("That problem is not in this practice pack.", 400);

    const windowStart = new Date(
      Date.parse(submittedAt) - SPAM_WINDOW_MS,
    ).toISOString();
    const prior = db
      .prepare(
        `SELECT COUNT(*) AS count FROM attempts
         WHERE child_id = ? AND submitted_at > ? AND submitted_at <= ?`,
      )
      .get(childId, windowStart, submittedAt) as { count: number };
    const elapsedMs = Date.parse(submittedAt) - Date.parse(shownAt);
    const flags = integrityFlags({
      answer: input.answer,
      elapsedMs,
      priorInWindow: prior.count,
    });
    const correct = gradeAnswer(itemId, input.answer);
    const economy = planAttemptEconomy(db, {
      childId,
      sessionId,
      idempotencyKey,
      timeZone: child.timezone,
      submittedAt,
      skill: item.skill,
      correct,
      flags,
      practiceLane: session.practice_lane,
      history: evidenceForSkill(db, childId, item.skill),
      previousBand: readSkillClientView(db, childId, item.skill)?.bandLabel ?? null,
    });
    const beats = buildFourBeat({
      correct,
      flags,
      item,
      canonicalAnswer: canonicalAnswer(itemId),
    });
    saveSkillState(db, childId, item.skill, economy.clientView);
    const quietResume = takePendingPauseHold(db, childId, idempotencyKey);
    const attemptId = randomUUID();
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO attempts (
         id, child_id, session_id, idempotency_key, item_id, answer, shown_at,
         submitted_at, correct, lane, celebration_tier, flags_json, beats_json,
         client_view_json, created_at, policy_version, resume_presentation
       ) VALUES (
         @id, @child_id, @session_id, @idempotency_key, @item_id, @answer, @shown_at,
         @submitted_at, @correct, @lane, @celebration_tier, @flags_json, @beats_json,
         @client_view_json, @created_at, @policy_version, @resume_presentation
       )`,
    ).run({
      id: attemptId,
      child_id: childId,
      session_id: sessionId,
      idempotency_key: idempotencyKey,
      item_id: itemId,
      answer: input.answer,
      shown_at: shownAt,
      submitted_at: submittedAt,
      correct: correct ? 1 : 0,
      lane: economy.lane,
      celebration_tier: economy.celebrationTier,
      flags_json: JSON.stringify(flags),
      beats_json: JSON.stringify(beats),
      client_view_json: JSON.stringify(economy.clientView),
      created_at: createdAt,
      policy_version: POLICY_VERSION,
      resume_presentation: quietResume ? "quiet" : "live",
    });
    commitAttemptEconomy(db, {
      childId,
      attemptId,
      sessionId,
      timeZone: child.timezone,
      submittedAt,
      observedAt: options?.now ?? createdAt,
      createdAt,
      practiceLane: session.practice_lane,
      integrityLane: economy.lane,
      celebrationTier: economy.celebrationTier,
      mints: economy.mints,
    });
    db.prepare(
      `UPDATE practice_sessions SET item_index = ? WHERE id = ?`,
    ).run((session.item_index + 1) % ITEM_CATALOG.length, session.id);
    const stored = findAttempt(db, childId, idempotencyKey);
    if (!stored) throw new DomainError("Attempt was not saved.", 500);
    const log = readAttemptLog(db, stored.id);
    if (log.policyVersion !== POLICY_VERSION) {
      throw new DomainError("Attempt log is missing policy_version.", 500);
    }
    return resultFromRow(db, stored, false);
  });

  try {
    return commit.immediate();
  } catch (error) {
    if (isUniqueConstraint(error)) {
      const existing = findAttempt(db, childId, idempotencyKey);
      if (existing) return resultFromRow(db, existing, true);
    }
    throw error;
  }
}

