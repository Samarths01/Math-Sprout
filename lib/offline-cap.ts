import type Database from "better-sqlite3";
import { DomainError, getChild } from "@/lib/domain";
import { OFFLINE_QUEUE_CAP } from "@/lib/offline-queue";

/**
 * Parent-visible offline cap. Same calm waiting shape as a pause hold.
 * The copy is a sync limit. It is not consent pause or revoke.
 * The stored file is the waiting count. The answer is not stored.
 */
export type OfflineCapView = {
  visible: true;
  waiting: number;
  copyKey: "offline.cap.waiting";
  detailKey: "offline.cap.detail";
};

function readCount(db: Database.Database, childId: string): number | null {
  const row = db
    .prepare(`SELECT offline_cap_json FROM consents WHERE child_id = ?`)
    .get(childId) as { offline_cap_json: string | null } | undefined;
  if (!row?.offline_cap_json) return null;
  try {
    const parsed = JSON.parse(row.offline_cap_json) as { waiting?: unknown };
    if (typeof parsed.waiting !== "number" || !Number.isInteger(parsed.waiting)) return null;
    if (parsed.waiting < OFFLINE_QUEUE_CAP) return null;
    return OFFLINE_QUEUE_CAP;
  } catch {
    return null;
  }
}

function writeCount(db: Database.Database, childId: string, waiting: number | null): void {
  const json = waiting === null ? null : JSON.stringify({ waiting });
  const updated = db
    .prepare(`UPDATE consents SET offline_cap_json = ? WHERE child_id = ?`)
    .run(json, childId);
  if (updated.changes === 0) {
    throw new DomainError("Offline limit could not be recorded.", 409);
  }
}

function viewFor(waiting: number): OfflineCapView {
  return {
    visible: true,
    waiting,
    copyKey: "offline.cap.waiting",
    detailKey: "offline.cap.detail",
  };
}

/** Parent home reads this only while practice is granted and the cap is full. */
export function readOfflineCap(
  db: Database.Database,
  guardianId: string,
  childId: string,
): OfflineCapView | null {
  const child = getChild(db, guardianId, childId);
  if (child.consentStatus !== "granted") return null;
  const waiting = readCount(db, childId);
  if (waiting === null) return null;
  return viewFor(waiting);
}

/**
 * Record or clear the parent-visible cap.
 * A count below the cap clears it. Allowed only while consent is granted.
 */
export function registerOfflineCap(
  db: Database.Database,
  guardianId: string,
  childId: string,
  waiting: number,
): OfflineCapView | { visible: false; waiting: 0 } {
  const child = getChild(db, guardianId, childId);
  if (child.consentStatus !== "granted") {
    throw new DomainError("The offline limit is recorded only while practice is allowed.", 409);
  }
  if (!Number.isInteger(waiting) || waiting < OFFLINE_QUEUE_CAP) {
    writeCount(db, childId, null);
    return { visible: false, waiting: 0 };
  }
  writeCount(db, childId, OFFLINE_QUEUE_CAP);
  return viewFor(OFFLINE_QUEUE_CAP);
}
