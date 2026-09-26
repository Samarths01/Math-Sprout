import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as submitAttemptRoute } from "@/app/api/children/[id]/attempts/route";
import { POST as startSessionRoute } from "@/app/api/children/[id]/sessions/route";
import { POST as issueItemsRoute } from "@/app/api/children/[id]/sessions/[sessionId]/items/route";
import { getDb } from "@/lib/db";
import { createChild, createGuardian, createSession, setConsent } from "@/lib/domain";

const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-resume-"));
process.env.DATABASE_PATH = path.join(dir, "app.sqlite");

const cookieState = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get(name: string) {
      if (!cookieState.token || name !== "math_sprout_session") return undefined;
      return { name, value: cookieState.token };
    },
  }),
}));

type ChildRoute = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

type SessionRoute = (
  request: Request,
  context: { params: Promise<{ id: string; sessionId: string }> },
) => Promise<Response>;

function resetCachedDb(): void {
  const globalForDb = globalThis as typeof globalThis & {
    __mathSproutDb?: { close: () => void };
  };
  globalForDb.__mathSproutDb?.close();
  delete globalForDb.__mathSproutDb;
}

afterAll(() => {
  resetCachedDb();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  handler: ChildRoute | SessionRoute,
  url: string,
  params: { id: string; sessionId?: string },
  init?: RequestInit,
) {
  const invoke = handler as (
    request: Request,
    context: { params: Promise<{ id: string; sessionId?: string }> },
  ) => Promise<Response>;
  const response = await invoke(new Request(url, init), {
    params: Promise.resolve(params),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: response.status, body };
}

type InstanceRow = Record<string, unknown>;

function instanceRows(): InstanceRow[] {
  return getDb().prepare(`SELECT * FROM item_instances ORDER BY rowid`).all() as InstanceRow[];
}

function attemptRows(): InstanceRow[] {
  return getDb()
    .prepare(
      `SELECT id, item_instance_id, shown_at, submitted_at, idempotency_key
       FROM attempts ORDER BY rowid`,
    )
    .all() as InstanceRow[];
}

describe("stuck item survives a practice reload", () => {
  let childId = "";

  beforeAll(() => {
    resetCachedDb();
    process.env.DATABASE_PATH = path.join(dir, "app.sqlite");
    const db = getDb();
    const guardian = createGuardian(db, {
      email: "resume-parent@example.com",
      password: "correct-horse",
      timezone: "America/Los_Angeles",
    });
    const child = createChild(db, guardian.id, { displayName: "Ava" });
    setConsent(db, guardian.id, child.id, "grant");
    childId = child.id;
    cookieState.token = createSession(db, guardian.id);
  });

  it("returns the same item instance after next, stuck, and reload of /practice", async () => {
    const started = await call(
      startSessionRoute,
      `http://127.0.0.1/api/children/${childId}/sessions`,
      { id: childId },
      { method: "POST" },
    );
    expect(started.status).toBe(200);
    const startedBody = started.body as {
      sessionId?: string;
      item?: { id?: string; itemInstanceId?: string };
    } | null;
    const sessionId = startedBody?.sessionId ?? "";
    const firstInstanceId = startedBody?.item?.itemInstanceId ?? "";
    const itemId = startedBody?.item?.id ?? "";
    expect(sessionId).toBeTruthy();
    expect(firstInstanceId).toBeTruthy();

    const issued = getDb()
      .prepare(`SELECT canonical_answer AS answer FROM item_instances WHERE item_instance_id = ?`)
      .get(firstInstanceId) as { answer: string } | undefined;
    expect(issued?.answer).toBeTruthy();

    const answered = await call(
      submitAttemptRoute,
      `http://127.0.0.1/api/children/${childId}/attempts`,
      { id: childId },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "resume-next-01",
          sessionId,
          itemId,
          itemInstanceId: firstInstanceId,
          answer: issued?.answer,
          shownAt: "2026-06-15T18:00:00.000Z",
          submittedAt: "2026-06-15T18:00:02.000Z",
        }),
      },
    );
    expect(answered.status).toBe(200);
    const answeredBody = answered.body as {
      nextItem?: { itemInstanceId?: string };
      error?: string;
    } | null;
    const stuckInstanceId = answeredBody?.nextItem?.itemInstanceId ?? "";
    expect(stuckInstanceId, JSON.stringify(answered.body)).toBeTruthy();
    expect(stuckInstanceId).not.toBe(firstInstanceId);

    const beforeInstances = instanceRows();
    const beforeAttempts = attemptRows();
    const beforeCount = beforeInstances.length;
    expect(beforeInstances.map((row) => row.item_instance_id)).toContain(stuckInstanceId);
    expect(beforeAttempts).toHaveLength(1);

    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS _reload_writes (
        op TEXT NOT NULL,
        item_instance_id TEXT,
        issued_at TEXT
      );
      CREATE TRIGGER IF NOT EXISTS _item_instances_insert
      AFTER INSERT ON item_instances
      BEGIN
        INSERT INTO _reload_writes (op, item_instance_id, issued_at)
        VALUES ('insert', NEW.item_instance_id, NEW.issued_at);
      END;
      CREATE TRIGGER IF NOT EXISTS _item_instances_update
      AFTER UPDATE ON item_instances
      BEGIN
        INSERT INTO _reload_writes (op, item_instance_id, issued_at)
        VALUES ('update', NEW.item_instance_id, NEW.issued_at);
      END;
    `);

    const reloaded = await call(
      startSessionRoute,
      `http://127.0.0.1/api/children/${childId}/sessions`,
      { id: childId },
      { method: "POST" },
    );
    expect(reloaded.status).toBe(200);
    const reloadedBody = reloaded.body as {
      sessionId?: string;
      item?: { itemInstanceId?: string };
    } | null;
    expect(reloadedBody?.sessionId).toBe(sessionId);
    expect(reloadedBody?.item?.itemInstanceId).toBe(stuckInstanceId);

    const items = await call(
      issueItemsRoute,
      `http://127.0.0.1/api/children/${childId}/sessions/${sessionId}/items`,
      { id: childId, sessionId },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "reload-practice-items" }),
      },
    );
    expect(items.status, JSON.stringify(items.body)).toBe(200);
    const itemsBody = items.body as {
      items?: Array<{ itemInstanceId?: string }>;
    } | null;
    expect(itemsBody?.items?.map((item) => item.itemInstanceId)).toEqual([stuckInstanceId]);

    const afterInstances = instanceRows();
    const afterAttempts = attemptRows();
    const writes = db.prepare(`SELECT op, item_instance_id, issued_at FROM _reload_writes`).all();
    expect(afterInstances, `item_instances before=${beforeCount} after=${afterInstances.length}`).toEqual(
      beforeInstances,
    );
    expect(afterAttempts).toEqual(beforeAttempts);
    expect(writes, `writes while reloading; before=${beforeCount} after=${afterInstances.length}`).toEqual(
      [],
    );
  });
});
