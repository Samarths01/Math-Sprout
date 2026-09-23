import type Database from "better-sqlite3";
import { DomainError, getChild } from "@/lib/domain";
import { knownItem } from "@/lib/item-bank";

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

/** Identity of a try held across pause. The answer stays on the device until resume. */
export type PauseHoldReceipt = {
  idempotencyKey: string;
  sessionId: string;
};

/**
 * Parent-visible pause hold. Interface can render `copyKey` and `detailKey`.
 * `waiting` is the count of tries not yet credited. The answer is not included.
 */
export type PauseHoldView = {
  visible: true;
  waiting: number;
  copyKey: "pause.hold.waiting" | "pause.hold.empty" | "pause.hold.resuming";
  detailKey: "pause.hold.waiting.detail";
};

type HoldFile = { pending: PauseHoldReceipt[] };

export type PauseHoldAttempt = {
  idempotencyKey: string;
  sessionId: string;
  itemId: string;
  answer: string;
  shownAt: string;
  submittedAt: string;
};

function readFile(db: Database.Database, childId: string): HoldFile {
  const row = db
    .prepare(`SELECT hold_json FROM consents WHERE child_id = ?`)
    .get(childId) as { hold_json: string | null } | undefined;
  if (!row?.hold_json) return { pending: [] };
  try {
    const parsed = JSON.parse(row.hold_json) as { pending?: unknown };
    if (!Array.isArray(parsed.pending)) return { pending: [] };
    const pending: PauseHoldReceipt[] = [];
    for (const item of parsed.pending) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<PauseHoldReceipt>;
      if (typeof row.idempotencyKey !== "string" || typeof row.sessionId !== "string") continue;
      if (!KEY_PATTERN.test(row.idempotencyKey)) continue;
      pending.push({ idempotencyKey: row.idempotencyKey, sessionId: row.sessionId });
    }
    return { pending };
  } catch {
    return { pending: [] };
  }
}

function writeFile(db: Database.Database, childId: string, file: HoldFile): void {
  const json = file.pending.length === 0 ? null : JSON.stringify({ pending: file.pending });
  const updated = db
    .prepare(`UPDATE consents SET hold_json = ? WHERE child_id = ?`)
    .run(json, childId);
  if (updated.changes === 0) {
    throw new DomainError("Pause hold could not be recorded.", 409);
  }
}

function viewFor(waiting: number, status: "paused" | "granted"): PauseHoldView {
  const copyKey =
    status === "granted"
      ? "pause.hold.resuming"
      : waiting > 0
        ? "pause.hold.waiting"
        : "pause.hold.empty";
  return {
    visible: true,
    waiting,
    copyKey,
    detailKey: "pause.hold.waiting.detail",
  };
}

function requireHeldAttempt(attempt: PauseHoldAttempt): PauseHoldReceipt {
  const idempotencyKey = attempt.idempotencyKey?.trim?.() ?? "";
  const sessionId = attempt.sessionId?.trim?.() ?? "";
  if (!KEY_PATTERN.test(idempotencyKey)) {
    throw new DomainError(
      "Idempotency key must be 8–80 letters, numbers, underscores, or hyphens.",
      400,
    );
  }
  if (sessionId.length === 0) throw new DomainError("Session is required.", 400);
  if (!knownItem(attempt.itemId)) {
    throw new DomainError("That problem is not in this practice pack.", 400);
  }
  if (typeof attempt.answer !== "string" || attempt.answer.length > 80) {
    throw new DomainError("Answer must be a string up to 80 characters.", 400);
  }
  if (!Number.isFinite(Date.parse(attempt.shownAt))) {
    throw new DomainError("Shown time must be a valid time.", 400);
  }
  if (!Number.isFinite(Date.parse(attempt.submittedAt))) {
    throw new DomainError("Submitted time must be a valid time.", 400);
  }
  return { idempotencyKey, sessionId };
}

/**
 * Record a paused try where a parent can see it.
 * The stored receipt is the idempotency key and session id. The answer is not stored.
 * Allowed only while consent is paused, so a hold cannot hide on a granted child.
 */
export function registerPauseHold(
  db: Database.Database,
  guardianId: string,
  childId: string,
  attempt: PauseHoldAttempt,
): PauseHoldView {
  const child = getChild(db, guardianId, childId);
  if (child.consentStatus !== "paused") {
    throw new DomainError("A pause hold is recorded only while practice is paused.", 409);
  }
  const receipt = requireHeldAttempt(attempt);
  const session = db
    .prepare(`SELECT id FROM practice_sessions WHERE id = ? AND child_id = ?`)
    .get(receipt.sessionId, childId) as { id: string } | undefined;
  if (!session) throw new DomainError("Practice session not found.", 404);
  const file = readFile(db, childId);
  if (!file.pending.some((item) => item.idempotencyKey === receipt.idempotencyKey)) {
    file.pending.push(receipt);
    writeFile(db, childId, file);
  }
  return viewFor(file.pending.length, "paused");
}

/**
 * Parent home seam. Paused consent is always visible, including when nothing is waiting yet.
 * After grant, outstanding receipts stay visible until each try is credited.
 * Revoked consent is not a hold.
 */
export function readPauseHold(
  db: Database.Database,
  guardianId: string,
  childId: string,
): PauseHoldView | null {
  const child = getChild(db, guardianId, childId);
  const waiting = readFile(db, childId).pending.length;
  if (child.consentStatus === "paused") return viewFor(waiting, "paused");
  if (child.consentStatus === "granted" && waiting > 0) return viewFor(waiting, "granted");
  return null;
}

/**
 * A credited resume consumes the receipt. True means this try was held and must stay quiet.
 */
export function takePendingPauseHold(
  db: Database.Database,
  childId: string,
  idempotencyKey: string,
): boolean {
  const file = readFile(db, childId);
  const pending = file.pending.filter((item) => item.idempotencyKey !== idempotencyKey);
  if (pending.length === file.pending.length) return false;
  writeFile(db, childId, { pending });
  return true;
}

/** Quiet resume credits the try and does not present a celebration. */
export function showResumeCelebration(result: { resumePresentation?: string }): boolean {
  return result.resumePresentation !== "quiet";
}
