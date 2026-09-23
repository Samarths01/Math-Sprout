import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { hashPassword, verifyPassword } from "@/lib/passwords";
import {
  PRACTICE_BLOCK_REASONS,
  practiceGate,
  queueDisposition,
  statusForAction,
  type ConsentAction,
  type ConsentViewStatus,
  type StoredConsentStatus,
} from "@/lib/practice-gate";
import { FALLBACK_TIMEZONE, isValidTimeZone } from "@/lib/timezones";

export class DomainError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly queueDisposition?: "hold" | "drop",
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export type Guardian = {
  id: string;
  email: string;
  timezone: string | null;
  createdAt: string;
};

export type ChildProfile = {
  id: string;
  displayName: string;
  timezone: string;
  consentStatus: ConsentViewStatus;
};

export type ChildHome = {
  practiceAllowed: boolean;
  reason?: string;
  child: ChildProfile;
};

export type ParentChildSummary = ChildProfile & {
  practiceAllowed: boolean;
  reason?: string;
};

export type ParentHome = {
  guardian: Guardian;
  children: ParentChildSummary[];
  narrative: string;
};

export const PARENT_HOME_NARRATIVE =
  "This home shows who is set up and whether consent is granted. Practice rewards stay on each attempt. This home does not show a score, a streak, or a progress story.";

type GuardianRow = {
  id: string;
  email: string;
  password_hash: string;
  timezone: string | null;
  created_at: string;
};

type ChildJoinRow = {
  id: string;
  display_name: string;
  timezone: string;
  consent_status: StoredConsentStatus | null;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} '\u2019-]{0,39}$/u;

function nowIso(): string {
  return new Date().toISOString();
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String((error as { code?: string }).code).includes("SQLITE_CONSTRAINT")
  );
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!EMAIL_PATTERN.test(normalized) || normalized.length > 254) {
    throw new DomainError("Enter a valid email address.", 400);
  }
  return normalized;
}

export function assertPassword(password: string): string {
  if (password.length < 8) {
    throw new DomainError("Use at least 8 characters for the password.", 400);
  }
  if (password.length > 200) {
    throw new DomainError("Password is too long.", 400);
  }
  return password;
}

export function assertDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!NAME_PATTERN.test(trimmed)) {
    throw new DomainError(
      "Use a child name up to 40 letters, with spaces, apostrophes, or hyphens.",
      400,
    );
  }
  return trimmed;
}

export function assertTimeZone(value: string, label = "Timezone"): string {
  const trimmed = value.trim();
  if (!isValidTimeZone(trimmed)) {
    throw new DomainError(
      `${label} must be a valid IANA timezone, such as America/Los_Angeles.`,
      400,
    );
  }
  return trimmed;
}

export function resolveChildTimezone(input: {
  requested?: string | null;
  guardianTimezone?: string | null;
}): string {
  const requested = input.requested?.trim();
  if (requested) {
    return assertTimeZone(requested, "Child timezone");
  }
  const guardianTimezone = input.guardianTimezone?.trim();
  if (guardianTimezone) {
    return assertTimeZone(guardianTimezone, "Guardian timezone");
  }
  return FALLBACK_TIMEZONE;
}

/** Consent block for a new learning write. Replay of an existing key does not use this. */
export function consentDenied(status: ConsentViewStatus): DomainError {
  const gate = practiceGate(status);
  return new DomainError(
    gate.reason ?? PRACTICE_BLOCK_REASONS.none,
    403,
    queueDisposition(status) ?? "drop",
  );
}

export function parseConsentAction(value: unknown): ConsentAction {
  if (value === "grant" || value === "pause" || value === "revoke") {
    return value;
  }
  throw new DomainError(
    "Consent action must be grant, pause, or revoke.",
    400,
  );
}

function toGuardian(row: GuardianRow): Guardian {
  return {
    id: row.id,
    email: row.email,
    timezone: row.timezone,
    createdAt: row.created_at,
  };
}

function toChild(row: ChildJoinRow): ChildProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    timezone: row.timezone,
    consentStatus: row.consent_status ?? "none",
  };
}

function withGate(child: ChildProfile): ParentChildSummary {
  const gate = practiceGate(child.consentStatus);
  return {
    ...child,
    practiceAllowed: gate.practiceAllowed,
    ...(gate.reason ? { reason: gate.reason } : {}),
  };
}

export function createGuardian(
  db: Database.Database,
  input: { email: string; password: string; timezone?: string | null },
): Guardian {
  const email = assertEmail(input.email);
  const password = assertPassword(input.password);
  const timezone =
    input.timezone && input.timezone.trim().length > 0
      ? assertTimeZone(input.timezone, "Timezone")
      : null;
  const row: GuardianRow = {
    id: randomUUID(),
    email,
    password_hash: hashPassword(password),
    timezone,
    created_at: nowIso(),
  };
  try {
    db.prepare(
      `INSERT INTO guardians (id, email, password_hash, timezone, created_at)
       VALUES (@id, @email, @password_hash, @timezone, @created_at)`,
    ).run(row);
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new DomainError(
        "An account with that email already exists. Log in instead.",
        409,
      );
    }
    throw error;
  }
  return toGuardian(row);
}

export function authenticate(
  db: Database.Database,
  input: { email: string; password: string },
): Guardian {
  const email = assertEmail(input.email);
  const row = db
    .prepare("SELECT * FROM guardians WHERE email = ?")
    .get(email) as GuardianRow | undefined;
  if (!row || !verifyPassword(input.password, row.password_hash)) {
    throw new DomainError("Email or password is incorrect.", 401);
  }
  return toGuardian(row);
}

export function createSession(db: Database.Database, guardianId: string): string {
  const token = randomBytes(32).toString("hex");
  const createdAt = nowIso();
  const expiresAt = new Date(
    Date.now() + 14 * 24 * 60 * 60 * 1000,
  ).toISOString();
  db.prepare(
    `INSERT INTO sessions (token_hash, guardian_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(tokenHash(token), guardianId, createdAt, expiresAt);
  return token;
}

export function deleteSession(db: Database.Database, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
}

export function guardianFromSession(
  db: Database.Database,
  token: string,
): Guardian | null {
  const row = db
    .prepare(
      `SELECT g.*, s.expires_at AS session_expires_at
       FROM sessions s
       JOIN guardians g ON g.id = s.guardian_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash(token)) as
    | (GuardianRow & { session_expires_at: string })
    | undefined;
  if (!row) return null;
  if (row.session_expires_at <= nowIso()) {
    deleteSession(db, token);
    return null;
  }
  return toGuardian(row);
}

function requireGuardianRow(
  db: Database.Database,
  guardianId: string,
): GuardianRow {
  const row = db
    .prepare("SELECT * FROM guardians WHERE id = ?")
    .get(guardianId) as GuardianRow | undefined;
  if (!row) throw new DomainError("Sign in required.", 401);
  return row;
}

const childSelect = `
  SELECT c.id, c.display_name, c.timezone, cons.status AS consent_status
  FROM children c
  LEFT JOIN consents cons ON cons.child_id = c.id
`;

export function createChild(
  db: Database.Database,
  guardianId: string,
  input: { displayName: string; timezone?: string | null },
): ChildProfile {
  const guardian = requireGuardianRow(db, guardianId);
  const displayName = assertDisplayName(input.displayName);
  const timezone = resolveChildTimezone({
    requested: input.timezone,
    guardianTimezone: guardian.timezone,
  });
  const id = randomUUID();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO children (id, guardian_id, display_name, timezone, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, guardianId, displayName, timezone, createdAt);
  return {
    id,
    displayName,
    timezone,
    consentStatus: "none",
  };
}

export function listChildren(
  db: Database.Database,
  guardianId: string,
): ChildProfile[] {
  const rows = db
    .prepare(
      `${childSelect}
       WHERE c.guardian_id = ?
       ORDER BY c.created_at ASC`,
    )
    .all(guardianId) as ChildJoinRow[];
  return rows.map(toChild);
}

function requireOwnedChild(
  db: Database.Database,
  guardianId: string,
  childId: string,
): ChildProfile {
  const row = db
    .prepare(
      `${childSelect}
       WHERE c.id = ? AND c.guardian_id = ?`,
    )
    .get(childId, guardianId) as ChildJoinRow | undefined;
  if (!row) throw new DomainError("Child profile not found.", 404);
  return toChild(row);
}

export function getChild(
  db: Database.Database,
  guardianId: string,
  childId: string,
): ChildProfile {
  return requireOwnedChild(db, guardianId, childId);
}

export function setConsent(
  db: Database.Database,
  guardianId: string,
  childId: string,
  action: ConsentAction,
): {
  childId: string;
  status: StoredConsentStatus;
  practiceAllowed: boolean;
  reason?: string;
  updatedAt: string;
} {
  requireOwnedChild(db, guardianId, childId);
  const status = statusForAction(action);
  const updatedAt = nowIso();
  db.prepare(
    `INSERT INTO consents (child_id, status, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(child_id) DO UPDATE SET
       status = excluded.status,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(childId, status, updatedAt, guardianId);
  const gate = practiceGate(status);
  return {
    childId,
    status,
    practiceAllowed: gate.practiceAllowed,
    ...(gate.reason ? { reason: gate.reason } : {}),
    updatedAt,
  };
}

export function getConsent(
  db: Database.Database,
  guardianId: string,
  childId: string,
): {
  childId: string;
  status: ConsentViewStatus;
  practiceAllowed: boolean;
  reason?: string;
  updatedAt: string | null;
} {
  requireOwnedChild(db, guardianId, childId);
  const row = db
    .prepare("SELECT status, updated_at FROM consents WHERE child_id = ?")
    .get(childId) as { status: StoredConsentStatus; updated_at: string } | undefined;
  const status: ConsentViewStatus = row?.status ?? "none";
  const gate = practiceGate(status);
  return {
    childId,
    status,
    practiceAllowed: gate.practiceAllowed,
    ...(gate.reason ? { reason: gate.reason } : {}),
    updatedAt: row?.updated_at ?? null,
  };
}

export function getChildHome(
  db: Database.Database,
  guardianId: string,
  childId: string,
): ChildHome {
  const child = requireOwnedChild(db, guardianId, childId);
  const gate = practiceGate(child.consentStatus);
  return {
    practiceAllowed: gate.practiceAllowed,
    ...(gate.reason ? { reason: gate.reason } : {}),
    child,
  };
}

export function getParentHome(
  db: Database.Database,
  guardianId: string,
): ParentHome {
  const guardian = toGuardian(requireGuardianRow(db, guardianId));
  return {
    guardian,
    children: listChildren(db, guardianId).map(withGate),
    narrative: PARENT_HOME_NARRATIVE,
  };
}

export { PRACTICE_BLOCK_REASONS };
