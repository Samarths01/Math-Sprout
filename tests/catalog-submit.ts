import type Database from "better-sqlite3";
import { submitAttempt as submitIssuedAttempt, type SubmitAttemptInput } from "@/lib/attempts";

/**
 * Economy suites grade the fixed catalog. Clearing issued rows keeps that
 * legacy path, which runs only when a session has no item instances.
 */
export function submitCatalogAttempt(
  db: Database.Database,
  guardianId: string,
  childId: string,
  input: SubmitAttemptInput,
  options?: { now?: string },
) {
  db.prepare(`DELETE FROM item_instances WHERE session_id = ?`).run(input.sessionId);
  return submitIssuedAttempt(db, guardianId, childId, input, options);
}
