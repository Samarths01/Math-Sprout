import type Database from "better-sqlite3";
import type {
  ClientView,
  IntegrityFlag,
  ReviewLane,
} from "@/lib/attempt-contract";
import { DomainError } from "@/lib/domain";
import { catalogItem } from "@/lib/item-catalog";
import type { PracticeLane } from "@/lib/mastery";

/**
 * Server instrumentation for one stored try. Built from the attempt and
 * session rows. Not returned to the child, and not a live eval harness.
 */
export type AttemptLog = {
  policyVersion: string;
  attemptId: string;
  sessionId: string;
  idempotencyKey: string;
  concept: string;
  itemId: string;
  difficulty: number;
  practiceLane: PracticeLane;
  integrityLane: ReviewLane;
  correct: boolean;
  latencyMs: number;
  flags: IntegrityFlag[];
  clientView: ClientView;
};

type LogRow = {
  id: string;
  session_id: string;
  idempotency_key: string;
  item_id: string;
  correct: number;
  lane: ReviewLane;
  flags_json: string;
  client_view_json: string;
  shown_at: string;
  submitted_at: string;
  attempt_policy: string;
  practice_lane: PracticeLane;
  session_policy: string;
};

export function readAttemptLog(
  db: Database.Database,
  attemptId: string,
): AttemptLog {
  const row = db
    .prepare(
      `SELECT a.id, a.session_id, a.idempotency_key, a.item_id, a.correct,
              a.lane, a.flags_json, a.client_view_json, a.shown_at, a.submitted_at,
              a.policy_version AS attempt_policy,
              s.practice_lane, s.policy_version AS session_policy
       FROM attempts a
       JOIN practice_sessions s ON s.id = a.session_id
       WHERE a.id = ?`,
    )
    .get(attemptId) as LogRow | undefined;
  if (!row) throw new DomainError("Attempt was not saved.", 500);
  if (row.attempt_policy.length === 0 || row.session_policy.length === 0) {
    throw new DomainError("Attempt log is missing policy_version.", 500);
  }
  const item = catalogItem(row.item_id);
  if (!item) {
    throw new DomainError("That problem is not in this practice pack.", 500);
  }
  const parsed = JSON.parse(row.client_view_json) as Partial<ClientView>;
  const clientView: ClientView = {
    bandLabel: parsed.bandLabel ?? "Still learning",
    showConceptChip: parsed.showConceptChip === true,
    celebrationTier: parsed.celebrationTier ?? "none",
  };
  return {
    policyVersion: row.attempt_policy,
    attemptId: row.id,
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
    concept: item.skill,
    itemId: row.item_id,
    difficulty: item.grade,
    practiceLane: row.practice_lane,
    integrityLane: row.lane,
    correct: row.correct === 1,
    latencyMs: Date.parse(row.submitted_at) - Date.parse(row.shown_at),
    flags: JSON.parse(row.flags_json) as IntegrityFlag[],
    clientView,
  };
}
