import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  buildCommands,
  createBuildResolver,
  currentAppBuildSha,
  formatParentBuildLabel,
  primeAppBuildSha,
  refreshAppBuildSha,
  resetBuildCacheForTests,
  stopBuildShaRefresh,
  warnIfBuildUnknown,
} from "@/lib/app-build";
import { formatAttemptLogLine, readAttemptLog } from "@/lib/attempt-log";
import { startPracticeSession, submitAttempt } from "@/lib/attempts";
import { ParentBuildFooter } from "@/components/build-footer";
import { readCompanion } from "@/lib/companion";
import { openDatabase } from "@/lib/db";
import { createChild, createGuardian, getChildHome, setConsent } from "@/lib/domain";

const cleanups: Array<() => void> = [];
const WHEN = "2026-06-15T18:00:00.000Z";

afterEach(() => {
  stopBuildShaRefresh();
  while (cleanups.length > 0) cleanups.pop()?.();
});

function seedPractice(db: ReturnType<typeof tempDb>) {
  const guardian = createGuardian(db, {
    email: "parent@example.com",
    password: "correct-horse",
    timezone: "America/Los_Angeles",
  });
  const child = createChild(db, guardian.id, {
    displayName: "Leo",
    timezone: "America/Los_Angeles",
  });
  setConsent(db, guardian.id, child.id, "grant");
  return { guardian, child };
}

function attemptInput(sessionId: string) {
  return {
    idempotencyKey: "build-tag-0001",
    sessionId,
    itemId: "ops-g2-add",
    answer: "42",
    shownAt: new Date(Date.parse(WHEN) - 2_000).toISOString(),
    submittedAt: WHEN,
  };
}

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-build-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function assertChildPayloadSealed(value: unknown) {
  const dumped = JSON.stringify(value);
  expect(dumped).not.toMatch(/build_sha|policy_version|buildSha|policyVersion/);
}

type GitExec = typeof buildCommands.execFile;

function restoreGit(original: {
  execFile: GitExec;
  statSync: typeof buildCommands.statSync;
  readFileSync: typeof buildCommands.readFileSync;
}) {
  buildCommands.execFile = original.execFile;
  buildCommands.statSync = original.statSync;
  buildCommands.readFileSync = original.readFileSync;
  resetBuildCacheForTests();
}

function installGit(exec: GitExec) {
  const original = {
    execFile: buildCommands.execFile,
    statSync: buildCommands.statSync,
    readFileSync: buildCommands.readFileSync,
  };
  resetBuildCacheForTests();
  buildCommands.execFile = exec;
  return () => restoreGit(original);
}

describe("app build tag", () => {
  it("prefers APP_BUILD_SHA, then a background git describe, then unknown", async () => {
    let described = 0;
    const deployed = createBuildResolver({
      env: () => "abc123",
      describe: async () => {
        described += 1;
        return "from-git-dirty";
      },
      headStamp: () => "stamp",
      now: () => 0,
    });
    expect(deployed.current()).toBe("abc123");
    await deployed.refresh();
    expect(described).toBe(0);

    const fromGit = createBuildResolver({
      env: () => "   ",
      describe: async () => "from-git",
      headStamp: () => "stamp",
      now: () => 0,
    });
    expect(fromGit.current()).toBe("unknown");
    await fromGit.refresh();
    expect(fromGit.current()).toBe("from-git");

    const blank = createBuildResolver({
      env: () => "",
      describe: async () => "  ",
      headStamp: () => null,
      now: () => 0,
    });
    expect(blank.current()).toBe("unknown");
    await blank.refresh();
    expect(blank.current()).toBe("unknown");

    const thrown = createBuildResolver({
      env: () => undefined,
      describe: async () => {
        throw new Error("git unavailable");
      },
      headStamp: () => null,
      now: () => 0,
    });
    expect(thrown.current()).toBe("unknown");
    await thrown.refresh();
    expect(thrown.current()).toBe("unknown");
    await primeAppBuildSha();
    expect(currentAppBuildSha().trim().length).toBeGreaterThan(0);
  });

  it("keeps a dirty suffix and refreshes in the background when HEAD changes or the TTL elapses", async () => {
    let stamp = "head-a";
    let described = "abc123def456";
    let now = 1_000;
    let calls = 0;
    const resolver = createBuildResolver({
      env: () => undefined,
      describe: async () => {
        calls += 1;
        return described;
      },
      headStamp: () => stamp,
      now: () => now,
    });
    expect(resolver.current()).toBe("unknown");
    await resolver.refresh();
    expect(resolver.current()).toBe("abc123def456");
    expect(calls).toBe(1);
    described = "ignored-while-cached";
    expect(resolver.current()).toBe("abc123def456");
    await resolver.refresh();
    expect(calls).toBe(1);
    stamp = "head-b";
    described = "fff999111222";
    expect(resolver.current()).toBe("abc123def456");
    await resolver.refresh();
    expect(resolver.current()).toBe("fff999111222");
    described = "fff999111222-dirty";
    now = 1_000 + 4_999;
    expect(resolver.current()).toBe("fff999111222");
    await resolver.refresh();
    expect(resolver.current()).toBe("fff999111222");
    now = 1_000 + 5_000;
    expect(resolver.current()).toBe("fff999111222");
    await resolver.refresh();
    expect(resolver.current()).toBe("fff999111222-dirty");
  });

  it("reads a dirty describe from git and a new tag after HEAD's mtime changes", async () => {
    const original = {
      execFile: buildCommands.execFile,
      statSync: buildCommands.statSync,
      readFileSync: buildCommands.readFileSync,
    };
    let headMtime = 10;
    let described = "aaa111bbb222\n";
    const seen: Array<{ command: string; timeout?: number; killSignal?: string; maxBuffer?: number }> =
      [];
    buildCommands.execFile = ((file, args, options, callback) => {
      const command = args[0] ?? "";
      seen.push({
        command,
        timeout: options.timeout,
        killSignal: options.killSignal,
        maxBuffer: options.maxBuffer,
      });
      if (file !== "git") {
        callback(new Error("not git"), "", "");
        return;
      }
      if (command === "describe") {
        callback(null, described, "");
        return;
      }
      if (command === "rev-parse") {
        callback(null, ".git\n", "");
        return;
      }
      callback(null, "", "");
    }) as GitExec;
    buildCommands.statSync = ((target: Parameters<typeof statSync>[0]) => {
      const name = String(target);
      return { mtimeMs: name.endsWith("HEAD") ? headMtime : headMtime + 3 } as ReturnType<
        typeof statSync
      >;
    }) as typeof buildCommands.statSync;
    buildCommands.readFileSync = ((target: Parameters<typeof readFileSync>[0]) => {
      if (String(target).endsWith("HEAD")) return "ref: refs/heads/main";
      return "";
    }) as typeof buildCommands.readFileSync;
    resetBuildCacheForTests();

    try {
      await primeAppBuildSha();
      expect(currentAppBuildSha()).toBe("aaa111bbb222");
      expect(seen.some((call) => call.command === "rev-parse")).toBe(true);
      expect(seen.find((call) => call.command === "describe")).toMatchObject({
        timeout: 1_500,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024,
      });
      const describes = seen.filter((call) => call.command === "describe").length;
      described = "should-stay-cached\n";
      expect(currentAppBuildSha()).toBe("aaa111bbb222");
      await refreshAppBuildSha();
      expect(seen.filter((call) => call.command === "describe")).toHaveLength(describes);
      headMtime = 40;
      described = "ccc444ddd555-dirty\n";
      expect(currentAppBuildSha()).toBe("aaa111bbb222");
      await refreshAppBuildSha();
      expect(currentAppBuildSha()).toBe("ccc444ddd555-dirty");
      expect(formatParentBuildLabel("ccc444ddd555-dirty")).toBe("Build ccc444ddd555-dirty");
      expect(formatParentBuildLabel("0123456789abcdef0123456789abcdef01234567")).toBe(
        "Build 0123456789ab",
      );
    } finally {
      restoreGit(original);
    }
  });

  it("stores a non-empty tag when git errors, and still saves the attempt", async () => {
    const restore = installGit((_file, _args, _options, callback) => {
      callback(new Error("git failed"), "", "");
    });
    try {
      await primeAppBuildSha();
      expect(currentAppBuildSha()).toBe("unknown");
      const db = tempDb();
      const { guardian, child } = seedPractice(db);
      const session = startPracticeSession(db, guardian.id, child.id);
      const result = submitAttempt(db, guardian.id, child.id, attemptInput(session.sessionId), {
        now: WHEN,
      });
      const attempt = db
        .prepare(`SELECT build_sha FROM attempts WHERE id = ?`)
        .get(result.attemptId) as { build_sha: string };
      expect(result.attemptId).toBeTruthy();
      expect(attempt.build_sha).toBe("unknown");
      expect(attempt.build_sha.trim().length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("returns from submit without waiting for a hung git refresh", async () => {
    let describes = 0;
    const restore = installGit((_file, args, options, _callback) => {
      if (args[0] === "describe") {
        describes += 1;
        expect(options.timeout).toBe(1_500);
        expect(options.killSignal).toBe("SIGKILL");
      }
    });
    try {
      const db = tempDb();
      const { guardian, child } = seedPractice(db);
      const started = Date.now();
      const session = startPracticeSession(db, guardian.id, child.id);
      const result = submitAttempt(db, guardian.id, child.id, attemptInput(session.sessionId), {
        now: WHEN,
      });
      expect(Date.now() - started).toBeLessThan(800);
      expect(describes).toBe(1);
      const attempt = db
        .prepare(`SELECT build_sha FROM attempts WHERE id = ?`)
        .get(result.attemptId) as { build_sha: string };
      expect(attempt.build_sha.trim().length).toBeGreaterThan(0);
      await refreshAppBuildSha();
      expect(currentAppBuildSha()).toBe("unknown");
    } finally {
      restore();
    }
  });

  it("keeps the last good tag after a later refresh fails", async () => {
    let headMtime = 10;
    let fail = false;
    const restore = installGit((_file, args, _options, callback) => {
      if (args[0] === "rev-parse") {
        callback(null, ".git\n", "");
        return;
      }
      if (fail) {
        callback(new Error("describe failed"), "", "");
        return;
      }
      callback(null, "abc123def456\n", "");
    });
    buildCommands.statSync = ((target: Parameters<typeof statSync>[0]) => {
      const name = String(target);
      return { mtimeMs: name.endsWith("HEAD") ? headMtime : headMtime + 1 } as ReturnType<
        typeof statSync
      >;
    }) as typeof buildCommands.statSync;
    buildCommands.readFileSync = ((target: Parameters<typeof readFileSync>[0]) => {
      if (String(target).endsWith("HEAD")) return "ref: refs/heads/main";
      return "";
    }) as typeof buildCommands.readFileSync;
    try {
      await primeAppBuildSha();
      expect(currentAppBuildSha()).toBe("abc123def456");
      fail = true;
      headMtime = 80;
      expect(currentAppBuildSha()).toBe("abc123def456");
      await refreshAppBuildSha();
      expect(currentAppBuildSha()).toBe("abc123def456");
      const db = tempDb();
      const { guardian, child } = seedPractice(db);
      const session = startPracticeSession(db, guardian.id, child.id);
      const result = submitAttempt(db, guardian.id, child.id, attemptInput(session.sessionId), {
        now: WHEN,
      });
      const attempt = db
        .prepare(`SELECT build_sha FROM attempts WHERE id = ?`)
        .get(result.attemptId) as { build_sha: string };
      expect(attempt.build_sha).toBe("abc123def456");
    } finally {
      restore();
    }
  });

  it("spawns git once when two refreshes overlap", async () => {
    let describes = 0;
    let release: ((error: Error | null, stdout: string, stderr: string) => void) | null = null;
    const restore = installGit((_file, args, _options, callback) => {
      if (args[0] === "rev-parse") {
        callback(null, ".git\n", "");
        return;
      }
      describes += 1;
      release = callback;
    });
    try {
      const first = refreshAppBuildSha();
      const second = refreshAppBuildSha();
      expect(describes).toBe(1);
      release?.(null, "abc123def456\n", "");
      await first;
      await second;
      expect(currentAppBuildSha()).toBe("abc123def456");
      expect(describes).toBe(1);
    } finally {
      restore();
    }
  });

  it("swallows a refresh rejection so unhandledRejection never fires", async () => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown) => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    const restore = installGit(() => {
      throw new Error("git exploded");
    });
    const previous = process.env.APP_BUILD_SHA;
    delete process.env.APP_BUILD_SHA;
    try {
      currentAppBuildSha();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(seen).toEqual([]);
      expect(currentAppBuildSha()).toBe("unknown");
    } finally {
      process.off("unhandledRejection", onRejection);
      if (previous === undefined) delete process.env.APP_BUILD_SHA;
      else process.env.APP_BUILD_SHA = previous;
      restore();
    }
  });

  it("does no git or stamp work when APP_BUILD_SHA is set, even across the TTL", async () => {
    const previous = process.env.APP_BUILD_SHA;
    delete process.env.APP_BUILD_SHA;
    let gitCalls = 0;
    let statCalls = 0;
    const restore = installGit((file, args, options, callback) => {
      gitCalls += 1;
      if (args[0] === "rev-parse") {
        callback(null, ".git\n", "");
        return;
      }
      callback(null, "from-git\n", "");
      void file;
      void options;
    });
    buildCommands.statSync = ((..._args: Parameters<typeof statSync>) => {
      statCalls += 1;
      return { mtimeMs: 10 } as ReturnType<typeof statSync>;
    }) as typeof buildCommands.statSync;
    buildCommands.readFileSync = (() => "ref: refs/heads/main") as typeof buildCommands.readFileSync;
    try {
      await primeAppBuildSha();
      gitCalls = 0;
      statCalls = 0;
      process.env.APP_BUILD_SHA = "deployed-sha";
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-15T18:00:00.000Z"));
      expect(currentAppBuildSha()).toBe("deployed-sha");
      expect(currentAppBuildSha()).toBe("deployed-sha");
      vi.setSystemTime(new Date("2026-06-15T18:00:06.000Z"));
      expect(currentAppBuildSha()).toBe("deployed-sha");
      vi.setSystemTime(new Date("2026-06-15T18:00:12.000Z"));
      expect(currentAppBuildSha()).toBe("deployed-sha");
      await Promise.resolve();
      expect(gitCalls).toBe(0);
      expect(statCalls).toBe(0);
    } finally {
      vi.useRealTimers();
      if (previous === undefined) delete process.env.APP_BUILD_SHA;
      else process.env.APP_BUILD_SHA = previous;
      restore();
    }
  });

  it("warns once when the tag is unknown and does not throw in production", () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message) => {
      warnings.push(String(message));
    });
    const previous = process.env.NODE_ENV;
    try {
      warnIfBuildUnknown("abc123");
      expect(warnings).toEqual([]);
      process.env.NODE_ENV = "production";
      expect(() => warnIfBuildUnknown("unknown")).not.toThrow();
      process.env.NODE_ENV = "development";
      expect(() => warnIfBuildUnknown("unknown")).not.toThrow();
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("APP_BUILD_SHA");
      expect(warnings[0]).toContain("Before/after analysis will exclude these rows");
    } finally {
      process.env.NODE_ENV = previous;
      spy.mockRestore();
    }
  });

  it("stores a non-empty build tag on a new attempt and session, and the log line includes it", async () => {
    await primeAppBuildSha();
    const db = tempDb();
    const guardian = createGuardian(db, {
      email: "parent@example.com",
      password: "correct-horse",
      timezone: "America/Los_Angeles",
    });
    const child = createChild(db, guardian.id, {
      displayName: "Leo",
      timezone: "America/Los_Angeles",
    });
    setConsent(db, guardian.id, child.id, "grant");
    const emitted: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((message) => {
      emitted.push(String(message));
    });
    const session = startPracticeSession(db, guardian.id, child.id);
    const shown = new Date(Date.parse(WHEN) - 2_000).toISOString();
    const result = submitAttempt(
      db,
      guardian.id,
      child.id,
      {
        idempotencyKey: "build-tag-0001",
        sessionId: session.sessionId,
        itemId: "ops-g2-add",
        answer: "42",
        shownAt: shown,
        submittedAt: WHEN,
      },
      { now: WHEN },
    );
    spy.mockRestore();

    const attempt = db
      .prepare(`SELECT build_sha, policy_version FROM attempts WHERE id = ?`)
      .get(result.attemptId) as { build_sha: string | null; policy_version: string };
    const storedSession = db
      .prepare(`SELECT build_sha, policy_version FROM practice_sessions WHERE id = ?`)
      .get(session.sessionId) as { build_sha: string | null; policy_version: string };
    expect(attempt.policy_version).toBe("rules-v0");
    expect(storedSession.policy_version).toBe("rules-v0");
    expect(attempt.build_sha).toBe(currentAppBuildSha());
    expect(storedSession.build_sha).toBe(currentAppBuildSha());
    expect(attempt.build_sha?.trim().length).toBeGreaterThan(0);

    const log = readAttemptLog(db, result.attemptId);
    const line = emitted.find((entry) => entry.includes("build_sha="));
    expect(line).toBe(formatAttemptLogLine(log));
    expect(line).toContain(`policy_version=${log.policyVersion}`);
    expect(line).toContain(`build_sha=${attempt.build_sha}`);
    expect(line).not.toContain("build_sha= ");

    expect(result).not.toHaveProperty("buildSha");
    expect(result.clientView).not.toHaveProperty("buildSha");
    expect(session).not.toHaveProperty("buildSha");
    assertChildPayloadSealed(result);
    assertChildPayloadSealed(result.clientView);
    assertChildPayloadSealed(session);
    assertChildPayloadSealed(getChildHome(db, guardian.id, child.id));
    assertChildPayloadSealed(readCompanion(db, child.id, WHEN));
    expect(JSON.stringify(result)).not.toContain(attempt.build_sha as string);
    expect(JSON.stringify(session)).not.toContain(storedSession.build_sha as string);
  });

  it("renders the build footer on the parent home and keeps it off child routes", async () => {
    await primeAppBuildSha();
    const html = renderToStaticMarkup(createElement(ParentBuildFooter));
    expect(html).toContain('data-testid="parent-build-footer"');
    expect(html).toContain(`Build ${formatParentBuildLabel(currentAppBuildSha()).replace(/^Build /, "")}`);
    const parentPage = readFileSync(path.join(process.cwd(), "app/parent/page.tsx"), "utf8");
    expect(parentPage).toContain("<ParentBuildFooter />");
    const childRoot = path.join(process.cwd(), "app/child");
    const childFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx|ts)$/.test(entry)) childFiles.push(full);
      }
    };
    walk(childRoot);
    expect(childFiles.length).toBeGreaterThan(0);
    for (const file of childFiles) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("ParentBuildFooter");
      expect(source).not.toContain("parent-build-footer");
    }
  });

  it("leaves build_sha null on rows that predate the column", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-build-old-"));
    const filename = path.join(dir, "old.sqlite");
    const raw = new Database(filename);
    raw.exec(`
      CREATE TABLE practice_sessions (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active')),
        item_index INTEGER NOT NULL,
        started_at TEXT NOT NULL
      );
      INSERT INTO practice_sessions (id, child_id, status, item_index, started_at)
      VALUES ('sess-old', 'child-old', 'active', 0, '2026-01-01T00:00:00.000Z');
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        item_id TEXT NOT NULL,
        answer TEXT NOT NULL,
        shown_at TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        correct INTEGER NOT NULL,
        lane TEXT NOT NULL,
        celebration_tier TEXT NOT NULL,
        flags_json TEXT NOT NULL,
        beats_json TEXT NOT NULL,
        client_view_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO attempts (
        id, child_id, session_id, idempotency_key, item_id, answer, shown_at,
        submitted_at, correct, lane, celebration_tier, flags_json, beats_json,
        client_view_json, created_at
      ) VALUES (
        'attempt-old', 'child-old', 'sess-old', 'old-key-0001', 'ops-g2-add', '42',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z', 1, 'celebrate', 'full',
        '[]', '{}', '{}', '2026-01-01T00:00:02.000Z'
      );
    `);
    raw.close();
    const db = openDatabase(filename);
    cleanups.push(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    for (const table of ["attempts", "practice_sessions"] as const) {
      const column = (
        db.pragma(`table_info(${table})`) as Array<{ name: string; notnull: number }>
      ).find((row) => row.name === "build_sha");
      expect(column?.notnull).toBe(0);
    }
    const attempt = db
      .prepare(`SELECT build_sha FROM attempts WHERE id = ?`)
      .get("attempt-old") as { build_sha: string | null };
    const session = db
      .prepare(`SELECT build_sha FROM practice_sessions WHERE id = ?`)
      .get("sess-old") as { build_sha: string | null };
    expect(attempt.build_sha).toBeNull();
    expect(session.build_sha).toBeNull();

    const log = readAttemptLog(db, "attempt-old");
    expect(log.buildSha).toBe("unknown");
    expect(formatAttemptLogLine(log)).toContain("build_sha=unknown");
  });
});
