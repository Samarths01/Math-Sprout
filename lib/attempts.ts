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
import { consentDenied, DomainError, getChild, invalidAttemptError } from "@/lib/domain";
import { catalogItem, ITEM_CATALOG } from "@/lib/item-catalog";
import {
  assertOverflowCoprime,
  catalogSkillCount,
  OVERFLOW_OFFSET_SQL,
  overflowSlotCount,
  skillIndexForPosition,
} from "@/lib/session-plan";
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
import { formatAttemptLogLine, readAttemptLog, type AttemptLog } from "@/lib/attempt-log";
import { fuelFromEvents } from "@/lib/fuel";
import * as appBuild from "@/lib/app-build";
import { POLICY_VERSION } from "@/lib/policy";
import { takePendingPauseHold } from "@/lib/pause-hold";
import { practiceGate } from "@/lib/practice-gate";
import { answersMatch, type RequireForm } from "@/lib/templates/rational";
import {
  consumeItemInstance,
  focusForStoredAnswer,
  gradeStoredAnswer,
  presentIssuedItem,
  readItemInstance,
} from "@/lib/templates/issue";
import { formatExampleFor } from "@/lib/templates/format-example";
import {
  isFormatRejected,
  UNPARSEABLE_BEHAVIOR,
  unparseableChildLine,
  type FormatRejected,
  type UnparseableBehavior,
} from "@/lib/unparseable";
import {
  normalizedTypedAnswer,
  wrongFormCopy,
  wrongFormReasonFor,
} from "@/lib/wrong-form-copy";

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

export type SubmitAttemptInput = {
  idempotencyKey: string;
  sessionId: string;
  itemId: string;
  answer: string;
  shownAt: string;
  submittedAt: string;
  itemInstanceId?: string;
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
  item_instance_id: string | null;
  outcome: "correct" | "incorrect" | "form_mismatch" | null;
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
  for (const key of ["operands", "canonicalAnswer", "answerKey", "canonical_answer", "operandKey"]) {
    if (key in body) {
      throw new DomainError("The answer is scored from the stored problem.", 400);
    }
  }
  if (typeof body.answer !== "string") {
    throw new DomainError("Answer must be a string.", 400);
  }
  if (body.answer.length > 80) {
    throw new DomainError("Answer is too long.", 400);
  }
  const shownAt = requireText(body.shownAt, "Shown time");
  const submittedAt = requireText(body.submittedAt, "Submitted time");
  const itemInstanceId =
    typeof body.itemInstanceId === "string" && body.itemInstanceId.trim().length > 0
      ? body.itemInstanceId.trim()
      : undefined;
  if (itemInstanceId && !KEY_PATTERN.test(itemInstanceId)) {
    throw invalidAttemptError("That problem is not in this practice pack.");
  }
  return {
    idempotencyKey,
    sessionId: requireText(body.sessionId, "Session"),
    itemId: requireText(body.itemId, "Problem"),
    answer: body.answer,
    shownAt,
    submittedAt,
    ...(itemInstanceId ? { itemInstanceId } : {}),
  };
}

function requireSession(db: Database.Database, childId: string, sessionId: string) {
  const row = readPracticeSession(db, childId, sessionId);
  if (!row) throw new DomainError("Practice session not found.", 404);
  return row;
}

/** Slot numbers only increase. The stored lane start and overflow offset choose the skill. */
export function advancePracticeSlot(db: Database.Database, sessionId: string, slotSeq: number): void {
  const plan = db
    .prepare(
      `SELECT lane_start AS laneStart, overflow_offset AS overflowOffset
       FROM practice_sessions WHERE id = ?`,
    )
    .get(sessionId) as { laneStart: number; overflowOffset: number } | undefined;
  if (!plan) throw new DomainError("Practice session not found.", 404);
  const next = slotSeq + 1;
  const itemIndex = skillIndexForPosition(plan.laneStart, plan.overflowOffset, next - plan.laneStart);
  db.prepare(`UPDATE practice_sessions SET slot_seq = ?, item_index = ? WHERE id = ?`).run(
    next,
    itemIndex,
    sessionId,
  );
}

function presentSession(
  db: Database.Database,
  childId: string,
  session: {
    id: string;
    item_index: number;
    slot_seq: number;
    practice_lane: PracticeLane;
    phase: "practicing" | "boundary" | "closed";
  },
): PracticeSessionStart {
  const item = presentIssuedItem(db, childId, session.id, session.slot_seq);
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
              resume_presentation, item_instance_id, outcome
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
    if (typeof value !== "string") {
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

function isCompareMode(value: string): value is "rational" | "exact" {
  return value === "rational" || value === "exact";
}

/**
 * The child reason comes from this attempt and the instance row frozen at
 * issue: stored answer, require_form, canonical answer, compare mode, and
 * the stored grade. The live template is not read.
 * `null` means the instance has no frozen form (an attempt from before that
 * column). `undefined` means a form is frozen and this try is not a clean
 * wrong-form miss.
 */
function wrongFormReasonFromAttempt(
  db: Database.Database,
  row: AttemptRow,
  flags: readonly IntegrityFlag[],
) {
  // An attempt from before instances has nothing frozen. No lookup, no re-grade.
  if (!row.item_instance_id) return null;
  if (row.outcome != null) {
    const frozen = db
      .prepare(`SELECT require_form FROM item_instances WHERE item_instance_id = ?`)
      .get(row.item_instance_id) as { require_form: string | null } | undefined;
    if (!frozen || frozen.require_form == null) return null;
    return wrongFormReasonFor({
      flags,
      formMismatch: row.outcome === "form_mismatch",
      required: frozen.require_form,
    });
  }
  const frozen = db
    .prepare(
      `SELECT canonical_answer, compare_mode, require_form
       FROM item_instances
       WHERE item_instance_id = ?`,
    )
    .get(row.item_instance_id) as
    | { canonical_answer: string; compare_mode: string; require_form: string | null }
    | undefined;
  if (!frozen || frozen.require_form == null) return null;
  if (!isCompareMode(frozen.compare_mode)) return null;
  const verdict = answersMatch(
    frozen.canonical_answer,
    row.answer,
    frozen.compare_mode,
    frozen.require_form as RequireForm,
  );
  return wrongFormReasonFor({
    flags,
    formMismatch: verdict === "form_mismatch",
    required: frozen.require_form,
  });
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
    .prepare(`SELECT slot_seq FROM practice_sessions WHERE id = ?`)
    .get(row.session_id) as { slot_seq: number } | undefined;
  if (!session) throw new DomainError("Practice session not found.", 404);
  const beats = readBeats(row.beats_json);
  const flags = JSON.parse(row.flags_json) as IntegrityFlag[];
  const reason = wrongFormReasonFromAttempt(db, row, flags);
  if (row.celebration_tier === "full" && credits.length === 0) {
    throw new DomainError("full celebration requires a mint.", 500);
  }
  if (row.celebration_tier === "quietXp" && credits.length === 0) {
    throw new DomainError("quietXp celebration requires a mint.", 500);
  }
  const clientView = readClientView(row.client_view_json, row.celebration_tier);
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
    nextItem: presentIssuedItem(db, row.child_id, row.session_id, session.slot_seq),
    ...(row.resume_presentation === "quiet" ? { resumePresentation: "quiet" as const } : {}),
    ...(reason !== undefined ? { reason } : {}),
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
  const buildSha = appBuild.currentAppBuildSha();
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
    const skillCount = catalogSkillCount();
    const overflowSlots = overflowSlotCount();
    assertOverflowCoprime(overflowSlots, skillCount);
    const sessionId = randomUUID();
    db.prepare(
      `INSERT INTO practice_sessions (
         id, child_id, status, item_index, slot_seq, started_at, practice_lane, phase,
         policy_version, build_sha, lane_start, overflow_offset
       )
       SELECT ?, ?, 'active', ?, ?, ?, ?, 'practicing', ?, ?, ?, ${OVERFLOW_OFFSET_SQL}`,
    ).run(
      sessionId,
      childId,
      itemIndex % skillCount,
      itemIndex,
      nowIso(),
      progress.nextLane,
      POLICY_VERSION,
      buildSha,
      itemIndex,
      overflowSlots,
      overflowSlots,
      childId,
      skillCount,
    );
    const created = readPracticeSession(db, childId, sessionId);
    if (!created) throw new DomainError("Practice session was not saved.", 500);
    return created;
  });
  return presentSession(db, childId, open.immediate());
}

export function submitAnswer(
  db: Database.Database,
  guardianId: string,
  childId: string,
  input: SubmitAttemptInput,
  options?: { now?: string; unparseableBehavior?: UnparseableBehavior },
): AttemptResult | FormatRejected {
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

  const buildSha = appBuild.currentAppBuildSha();
  const commit = db.transaction((): { result: AttemptResult | FormatRejected; log: AttemptLog | null } => {
    const existing = findAttempt(db, childId, idempotencyKey);
    if (existing) return { result: resultFromRow(db, existing, true), log: null };

    const child = getChild(db, guardianId, childId);
    const gate = practiceGate(child.consentStatus);
    if (!gate.practiceAllowed) throw consentDenied(child.consentStatus);
    const session = requireSession(db, childId, sessionId);
    if (session.phase !== "practicing") {
      throw new DomainError(
        "This session has ended. Choose a lane to start the next one.",
        409,
        undefined,
        undefined,
        "session_ended",
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
    let correct = false;
    let beats: FourBeat;
    let economy: {
      lane: AttemptResult["lane"];
      celebrationTier: AttemptResult["celebrationTier"];
      clientView: ClientView;
      mints: Parameters<typeof commitAttemptEconomy>[1]["mints"];
    };
    let scoredItemId = itemId;
    let instanceId: string | null = null;
    let templateId: string | null = null;
    let difficultyStep: number | null = null;
    let estimatorEvidence: number | null = null;
    let attemptOutcome: "correct" | "incorrect" | "form_mismatch" = "incorrect";
    const skipEconomy = false;

    const issuedOnSession = db
      .prepare(`SELECT COUNT(*) AS count FROM item_instances WHERE session_id = ?`)
      .get(sessionId) as { count: number };
    if (issuedOnSession.count > 0 && !input.itemInstanceId) {
      throw invalidAttemptError("An issued problem id is required.");
    }

    if (input.itemInstanceId) {
      const instance = readItemInstance(db, input.itemInstanceId);
      if (!instance) {
        throw new DomainError(
          "That problem is not in this practice pack.",
          404,
          undefined,
          undefined,
          "unknown_instance",
        );
      }
      if (instance.childId !== childId || instance.sessionId !== sessionId) {
        throw new DomainError(
          "That problem is already locked.",
          409,
          undefined,
          undefined,
          "already_locked",
        );
      }
      if (instance.consumedAt) {
        throw new DomainError(
          "That problem is already locked.",
          409,
          undefined,
          undefined,
          "already_locked",
        );
      }
      const skillRow = db
        .prepare(
          `SELECT skill_id FROM item_template_versions
           WHERE template_id = ? AND template_version = ?`,
        )
        .get(instance.templateId, instance.templateVersion) as { skill_id: string } | undefined;
      const skillItem =
        ITEM_CATALOG.find((entry) => entry.skill === skillRow?.skill_id) ?? item;
      scoredItemId = skillItem.id;
      instanceId = instance.itemInstanceId;
      templateId = instance.templateId;
      difficultyStep = instance.difficultyStep;
      const verdict = gradeStoredAnswer(instance, input.answer);
      if (verdict === "unparseable") {
        const unparseableBehavior = options?.unparseableBehavior ?? UNPARSEABLE_BEHAVIOR;
        const meta = db
          .prepare(
            `SELECT provenance FROM item_template_versions
             WHERE template_id = ? AND template_version = ?`,
          )
          .get(instance.templateId, instance.templateVersion) as
          | { provenance: string }
          | undefined;
        if (!meta) throw new DomainError("That problem is not in this practice pack.", 404);
        const example = formatExampleFor(instance.answerKind, instance.canonicalAnswer);
        const seq = db
          .prepare(
            `SELECT COALESCE(MAX(reject_seq), 0) + 1 AS reject_seq
             FROM answer_format_rejects WHERE item_instance_id = ?`,
          )
          .get(instance.itemInstanceId) as { reject_seq: number };
        db.prepare(
          `INSERT INTO answer_format_rejects (
             item_instance_id, template_version, provenance, answer_kind,
             build_sha, policy_version, reject_seq, rejected_at
           ) VALUES (
             @item_instance_id, @template_version, @provenance, @answer_kind,
             @build_sha, @policy_version, @reject_seq, @rejected_at
           )`,
        ).run({
          item_instance_id: instance.itemInstanceId,
          template_version: instance.templateVersion,
          provenance: meta.provenance,
          answer_kind: example.answerKind,
          build_sha: buildSha,
          policy_version: POLICY_VERSION,
          reject_seq: seq.reject_seq,
          rejected_at: submittedAt,
        });
        if (unparseableBehavior === "lock") {
          consumeItemInstance(db, instance, idempotencyKey, submittedAt);
          advancePracticeSlot(db, session.id, session.slot_seq);
        }
        return {
          result: {
            type: "format_rejected",
            behavior: unparseableBehavior,
            hint: unparseableChildLine(
              unparseableBehavior,
              example.answerKind,
              example.formatExample,
            ),
          },
          log: null,
        };
      }
      correct = verdict === "correct";
      const formMiss = verdict === "form_mismatch";
      const valueMiss = verdict === "incorrect" || formMiss;
      attemptOutcome = formMiss ? "form_mismatch" : correct ? "correct" : "incorrect";
      estimatorEvidence = instance.evidenceEligible ? 1 : 0;
      if (formMiss && flags.length === 0 && instance.requireForm) {
        const copy = wrongFormCopy({
          typed: normalizedTypedAnswer(input.answer),
          canonical: instance.canonicalAnswer,
          required: instance.requireForm,
        });
        beats = {
          whatWentWell: copy.whatWentWell,
          oneFocus: copy.oneFocus,
          tryNext: copy.tryNext,
          lockIn: copy.lockIn,
        };
      } else {
        const focus = valueMiss ? focusForStoredAnswer(instance, input.answer) : null;
        beats = buildFourBeat({
          correct,
          flags,
          item: skillItem,
          canonicalAnswer: instance.canonicalAnswer,
          answerLine: instance.answerLine,
          ...(flags.length === 0 && valueMiss && focus
            ? { focus: focus.oneFocus, tryNext: focus.tryNext }
            : {}),
          ...(flags.length === 0 && correct ? { solidify: instance.whyItWorks ?? "" } : {}),
        });
      }
      const savedView = readSkillClientView(db, childId, skillItem.skill);
      economy = planAttemptEconomy(db, {
        childId,
        sessionId,
        idempotencyKey,
        timeZone: child.timezone,
        submittedAt,
        skill: skillItem.skill,
        correct,
        flags,
        practiceLane: session.practice_lane,
        history: evidenceForSkill(db, childId, skillItem.skill),
        previousBand: savedView?.bandLabel ?? null,
        countsForBand: instance.evidenceEligible,
        savedClientView: savedView,
      });
      if (instance.evidenceEligible) {
        saveSkillState(db, childId, skillItem.skill, economy.clientView);
      }
      consumeItemInstance(db, instance, idempotencyKey, submittedAt);
    } else {
      correct = gradeAnswer(itemId, input.answer);
      economy = planAttemptEconomy(db, {
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
      beats = buildFourBeat({
        correct,
        flags,
        item,
        canonicalAnswer: canonicalAnswer(itemId),
      });
      saveSkillState(db, childId, item.skill, economy.clientView);
      attemptOutcome = correct ? "correct" : "incorrect";
    }
    const quietResume = takePendingPauseHold(db, childId, idempotencyKey);
    const attemptId = randomUUID();
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO attempts (
         id, child_id, session_id, idempotency_key, item_id, answer, shown_at,
         submitted_at, correct, lane, celebration_tier, flags_json, beats_json,
         client_view_json, created_at, policy_version, build_sha, resume_presentation,
         item_instance_id, template_id, difficulty_step, estimator_evidence, outcome
       ) VALUES (
         @id, @child_id, @session_id, @idempotency_key, @item_id, @answer, @shown_at,
         @submitted_at, @correct, @lane, @celebration_tier, @flags_json, @beats_json,
         @client_view_json, @created_at, @policy_version, @build_sha, @resume_presentation,
         @item_instance_id, @template_id, @difficulty_step, @estimator_evidence, @outcome
       )`,
    ).run({
      id: attemptId,
      child_id: childId,
      session_id: sessionId,
      idempotency_key: idempotencyKey,
      item_id: scoredItemId,
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
      build_sha: buildSha,
      resume_presentation: quietResume ? "quiet" : "live",
      item_instance_id: instanceId,
      template_id: templateId,
      difficulty_step: difficultyStep,
      estimator_evidence: estimatorEvidence,
      outcome: attemptOutcome,
    });
    if (!skipEconomy) commitAttemptEconomy(db, {
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
    advancePracticeSlot(db, session.id, session.slot_seq);
    const stored = findAttempt(db, childId, idempotencyKey);
    if (!stored) throw new DomainError("Attempt was not saved.", 500);
    const log = readAttemptLog(db, stored.id);
    if (log.policyVersion !== POLICY_VERSION) {
      throw new DomainError("Attempt log is missing policy_version.", 500);
    }
    if (log.buildSha.trim().length === 0) {
      throw new DomainError("Attempt log is missing build_sha.", 500);
    }
    return { result: resultFromRow(db, stored, false), log };
  });

  try {
    const saved = commit.immediate();
    if (saved.log) console.info(formatAttemptLogLine(saved.log));
    return saved.result;
  } catch (error) {
    if (isUniqueConstraint(error)) {
      const existing = findAttempt(db, childId, idempotencyKey);
      if (existing) return resultFromRow(db, existing, true);
    }
    throw error;
  }
}

/** Scored tries only. An unreadable answer is not an attempt; use `submitAnswer`. */
export function submitAttempt(
  db: Database.Database,
  guardianId: string,
  childId: string,
  input: SubmitAttemptInput,
  options?: { now?: string },
): AttemptResult {
  const outcome = submitAnswer(db, guardianId, childId, input, options);
  if (isFormatRejected(outcome)) {
    throw new DomainError("An unreadable answer is not an attempt.", 422);
  }
  return outcome;
}

