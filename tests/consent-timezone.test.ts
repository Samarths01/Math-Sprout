import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "@/lib/db";
import {
  createChild,
  createGuardian,
  getChildHome,
  resolveChildTimezone,
  setConsent,
} from "@/lib/domain";
import {
  PRACTICE_BLOCK_REASONS,
  practiceClickOutcome,
  practiceGate,
} from "@/lib/practice-gate";
import { FALLBACK_TIMEZONE, timezoneFromFormValue } from "@/lib/timezones";

const cleanups: Array<() => void> = [];

function tempDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("timezone form values", () => {
  it("lets the server default when the parent leaves the suggested choice", () => {
    expect(timezoneFromFormValue("__default__", "")).toBeUndefined();
    expect(timezoneFromFormValue("__unset__", "")).toBeUndefined();
  });

  it("keeps an explicit zone and a custom zone", () => {
    expect(timezoneFromFormValue("America/Chicago", "")).toBe("America/Chicago");
    expect(timezoneFromFormValue("__other__", " America/New_York ")).toBe(
      "America/New_York",
    );
  });
});

describe("child.timezone persistence", () => {
  it("requires timezone on the child profile schema", () => {
    const db = tempDb();
    const columns = db.prepare("PRAGMA table_info(children)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const timezone = columns.find((column) => column.name === "timezone");
    expect(timezone?.notnull).toBe(1);
  });

  it("stores an explicit IANA timezone", () => {
    const db = tempDb();
    const guardian = createGuardian(db, {
      email: "parent@example.com",
      password: "correct-horse",
      timezone: "America/Chicago",
    });
    const child = createChild(db, guardian.id, {
      displayName: "Ava",
      timezone: "America/New_York",
    });
    const stored = db
      .prepare("SELECT timezone FROM children WHERE id = ?")
      .get(child.id) as { timezone: string };

    expect(child.timezone).toBe("America/New_York");
    expect(stored.timezone).toBe("America/New_York");
    expect(getChildHome(db, guardian.id, child.id).child.timezone).toBe(
      "America/New_York",
    );
  });

  it("defaults to the guardian timezone when the child timezone is omitted", () => {
    const db = tempDb();
    const guardian = createGuardian(db, {
      email: "parent@example.com",
      password: "correct-horse",
      timezone: "America/Chicago",
    });
    const child = createChild(db, guardian.id, { displayName: "Noah" });
    expect(child.timezone).toBe("America/Chicago");
    expect(getChildHome(db, guardian.id, child.id).child.timezone).toBe(
      "America/Chicago",
    );
  });

  it("defaults to America/Los_Angeles when neither timezone is set", () => {
    const db = tempDb();
    const guardian = createGuardian(db, {
      email: "parent@example.com",
      password: "correct-horse",
    });
    expect(guardian.timezone).toBeNull();
    const child = createChild(db, guardian.id, { displayName: "Mia" });
    expect(child.timezone).toBe(FALLBACK_TIMEZONE);
    expect(resolveChildTimezone({ requested: "  ", guardianTimezone: null })).toBe(
      FALLBACK_TIMEZONE,
    );
  });

  it("rejects an invalid timezone and does not insert a child", () => {
    const db = tempDb();
    const guardian = createGuardian(db, {
      email: "parent@example.com",
      password: "correct-horse",
    });
    expect(() =>
      createChild(db, guardian.id, {
        displayName: "Leo",
        timezone: "Not/AZone",
      }),
    ).toThrow(/IANA timezone/);
    const count = db.prepare("SELECT COUNT(*) AS count FROM children").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });
});

describe("consent gating", () => {
  it("allows practice only when consent is granted", () => {
    const db = tempDb();
    const guardian = createGuardian(db, {
      email: "parent@example.com",
      password: "correct-horse",
      timezone: "America/Los_Angeles",
    });
    const child = createChild(db, guardian.id, { displayName: "Ava" });

    const blocked = getChildHome(db, guardian.id, child.id);
    expect(blocked.practiceAllowed).toBe(false);
    expect(blocked.reason).toBe(PRACTICE_BLOCK_REASONS.none);
    expect(blocked.child.consentStatus).toBe("none");
    expect(practiceClickOutcome(blocked.practiceAllowed)).toBe("blocked");

    const granted = setConsent(db, guardian.id, child.id, "grant");
    const allowed = getChildHome(db, guardian.id, child.id);
    expect(granted.practiceAllowed).toBe(true);
    expect(allowed.practiceAllowed).toBe(true);
    expect(allowed.reason).toBeUndefined();
    expect(allowed.child.timezone).toBe("America/Los_Angeles");
    expect(practiceClickOutcome(allowed.practiceAllowed)).toBe("start-session");

    const paused = setConsent(db, guardian.id, child.id, "pause");
    expect(paused.practiceAllowed).toBe(false);
    expect(getChildHome(db, guardian.id, child.id).reason).toBe(
      PRACTICE_BLOCK_REASONS.paused,
    );

    const revoked = setConsent(db, guardian.id, child.id, "revoke");
    expect(revoked.practiceAllowed).toBe(false);
    expect(getChildHome(db, guardian.id, child.id).reason).toBe(
      PRACTICE_BLOCK_REASONS.revoked,
    );
    expect(practiceClickOutcome(false)).toBe("blocked");

    setConsent(db, guardian.id, child.id, "grant");
    expect(getChildHome(db, guardian.id, child.id).practiceAllowed).toBe(true);
  });

  it("keeps the child home payload free of progress fields", () => {
    const db = tempDb();
    const guardian = createGuardian(db, {
      email: "parent@example.com",
      password: "correct-horse",
    });
    const child = createChild(db, guardian.id, { displayName: "Ava" });
    const home = getChildHome(db, guardian.id, child.id);
    expect(Object.keys(home).sort()).toEqual(["child", "practiceAllowed", "reason"]);
    expect(Object.keys(home.child).sort()).toEqual([
      "consentStatus",
      "displayName",
      "id",
      "timezone",
    ]);
    expect(home).not.toHaveProperty("xp");
    expect(practiceGate("granted")).toEqual({ practiceAllowed: true });
  });

  it("keeps the ledger to attempt mints and the consent shell", () => {
    const db = tempDb();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name).sort()).toEqual([
      "answer_format_rejects",
      "attempts",
      "boundary_events",
      "children",
      "consents",
      "guardians",
      "item_instances",
      "item_template_versions",
      "learner_progress",
      "learner_skill_state",
      "practice_sessions",
      "qualifying_events",
      "sessions",
      "xp_events",
    ]);
  });
});
