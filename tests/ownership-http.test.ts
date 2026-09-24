import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as submitAttemptRoute } from "@/app/api/children/[id]/attempts/route";
import { GET as getConsent, POST as postConsent } from "@/app/api/children/[id]/consent/route";
import { GET as getCompanion } from "@/app/api/children/[id]/companion/route";
import { GET as getHome } from "@/app/api/children/[id]/home/route";
import { GET as getParentSummary } from "@/app/api/children/[id]/parent-summary/route";
import { POST as startSessionRoute } from "@/app/api/children/[id]/sessions/route";
import { GET as getBoundaryOptionsRoute } from "@/app/api/children/[id]/sessions/[sessionId]/boundary-options/route";
import { POST as endSessionRoute } from "@/app/api/children/[id]/sessions/[sessionId]/end/route";
import { POST as chooseLaneRoute } from "@/app/api/children/[id]/sessions/[sessionId]/lane/route";
import { getDb } from "@/lib/db";
import { createChild, createGuardian, createSession, setConsent } from "@/lib/domain";

const dir = mkdtempSync(path.join(tmpdir(), "math-sprout-http-"));
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

afterAll(() => {
  const globalForDb = globalThis as typeof globalThis & { __mathSproutDb?: { close: () => void } };
  globalForDb.__mathSproutDb?.close();
  delete globalForDb.__mathSproutDb;
  rmSync(dir, { recursive: true, force: true });
});

function count(table: "practice_sessions" | "attempts" | "boundary_events") {
  return (
    getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  ).count;
}

type ChildRoute = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

type SessionRoute = (
  request: Request,
  context: { params: Promise<{ id: string; sessionId: string }> },
) => Promise<Response>;

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
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return { status: response.status, body };
}

describe("child route ownership", () => {
  let childId = "";
  let sessionId = "";
  let ownerToken = "";
  let otherToken = "";

  beforeAll(() => {
    const db = getDb();
    const owner = createGuardian(db, {
      email: "owner@example.com",
      password: "correct-horse",
      timezone: "America/Los_Angeles",
    });
    const other = createGuardian(db, {
      email: "other@example.com",
      password: "correct-horse",
      timezone: "America/Los_Angeles",
    });
    const child = createChild(db, owner.id, { displayName: "Ava" });
    setConsent(db, owner.id, child.id, "grant");
    childId = child.id;
    ownerToken = createSession(db, owner.id);
    otherToken = createSession(db, other.id);
  });

  it("lets the owner start practice and hides that child from another guardian", async () => {
    cookieState.token = ownerToken;
    const started = await call(
      startSessionRoute,
      `http://127.0.0.1/api/children/${childId}/sessions`,
      { id: childId },
      { method: "POST" },
    );
    expect(started.status).toBe(200);
    sessionId = (started.body as { sessionId?: string } | null)?.sessionId ?? "";
    expect(sessionId).toBeTruthy();
    expect(count("practice_sessions")).toBe(1);

    const summary = await call(
      getParentSummary,
      `http://127.0.0.1/api/children/${childId}/parent-summary`,
      { id: childId },
    );
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      childId,
      practiced: false,
      minutes: 0,
      focusConcept: null,
      bandMovement: { from: null, to: null, moved: false },
      story: "No practice yet.",
    });
    expect(JSON.stringify(summary.body)).not.toMatch(
      /attemptId|\/attempts|score|confidence|href/i,
    );

    const companion = await call(
      getCompanion,
      `http://127.0.0.1/api/children/${childId}/companion`,
      { id: childId },
    );
    expect(companion.status).toBe(200);
    expect(companion.body).toMatchObject({
      streak: { state: "dormant", recovery: null },
      glance: { xp: 0, dayCount: null, pieces: 0, goal: 3 },
    });
    expect(JSON.stringify(companion.body)).not.toMatch(
      /scorePercent|confidence|xpAmount|judgment|judgement/i,
    );

    cookieState.token = otherToken;
    const routes: Array<{
      name: string;
      run: () => Promise<{ status: number; body: { error?: string } | null }>;
    }> = [
      {
        name: "home",
        run: () =>
          call(getHome, `http://127.0.0.1/api/children/${childId}/home`, { id: childId }),
      },
      {
        name: "parent summary",
        run: () =>
          call(
            getParentSummary,
            `http://127.0.0.1/api/children/${childId}/parent-summary`,
            { id: childId },
          ),
      },
      {
        name: "companion",
        run: () =>
          call(getCompanion, `http://127.0.0.1/api/children/${childId}/companion`, {
            id: childId,
          }),
      },
      {
        name: "consent read",
        run: () =>
          call(getConsent, `http://127.0.0.1/api/children/${childId}/consent`, { id: childId }),
      },
      {
        name: "consent write",
        run: () =>
          call(
            postConsent,
            `http://127.0.0.1/api/children/${childId}/consent`,
            { id: childId },
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "revoke" }),
            },
          ),
      },
      {
        name: "start session",
        run: () =>
          call(
            startSessionRoute,
            `http://127.0.0.1/api/children/${childId}/sessions`,
            { id: childId },
            { method: "POST" },
          ),
      },
      {
        name: "attempt",
        run: () =>
          call(
            submitAttemptRoute,
            `http://127.0.0.1/api/children/${childId}/attempts`,
            { id: childId },
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                idempotencyKey: "other-parent-key",
                sessionId,
                itemId: "ops-g2-add",
                answer: "42",
                shownAt: "2026-04-01T00:00:00.000Z",
                submittedAt: "2026-04-01T00:00:02.000Z",
              }),
            },
          ),
      },
      {
        name: "end session",
        run: () =>
          call(
            endSessionRoute,
            `http://127.0.0.1/api/children/${childId}/sessions/${sessionId}/end`,
            { id: childId, sessionId },
            { method: "POST" },
          ),
      },
      {
        name: "boundary options",
        run: () =>
          call(
            getBoundaryOptionsRoute,
            `http://127.0.0.1/api/children/${childId}/sessions/${sessionId}/boundary-options`,
            { id: childId, sessionId },
          ),
      },
      {
        name: "lane choice",
        run: () =>
          call(
            chooseLaneRoute,
            `http://127.0.0.1/api/children/${childId}/sessions/${sessionId}/lane`,
            { id: childId, sessionId },
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ lane: "challenge" }),
            },
          ),
      },
    ];

    for (const route of routes) {
      const result = await route.run();
      expect(result.status, route.name).toBe(404);
      expect(result.body?.error, route.name).toMatch(/not found/i);
    }

    expect(count("practice_sessions")).toBe(1);
    expect(count("attempts")).toBe(0);
    expect(count("boundary_events")).toBe(0);
    const consent = getDb()
      .prepare(`SELECT status FROM consents WHERE child_id = ?`)
      .get(childId) as { status: string };
    expect(consent.status).toBe("granted");
  });

  it("asks a signed-out caller to sign in", async () => {
    cookieState.token = undefined;
    const result = await call(
      getBoundaryOptionsRoute,
      `http://127.0.0.1/api/children/${childId}/sessions/${sessionId}/boundary-options`,
      { id: childId, sessionId },
    );
    expect(result.status).toBe(401);
    expect(result.body?.error).toMatch(/sign in/i);
    const companion = await call(
      getCompanion,
      `http://127.0.0.1/api/children/${childId}/companion`,
      { id: childId },
    );
    expect(companion.status).toBe(401);
    const summary = await call(
      getParentSummary,
      `http://127.0.0.1/api/children/${childId}/parent-summary`,
      { id: childId },
    );
    expect(summary.status).toBe(401);
  });

  it("still lets the owner submit and end that same session", async () => {
    cookieState.token = ownerToken;
    const attempt = await call(
      submitAttemptRoute,
      `http://127.0.0.1/api/children/${childId}/attempts`,
      { id: childId },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "owner-key-0001",
          sessionId,
          itemId: "ops-g2-add",
          answer: "42",
          shownAt: "2026-04-01T00:00:00.000Z",
          submittedAt: "2026-04-01T00:00:02.000Z",
        }),
      },
    );
    expect(attempt.status).toBe(200);
    expect(count("attempts")).toBe(1);
    const firstBody = attempt.body as {
      attemptId?: string;
      eventIds?: string[];
      clientView?: { bandLabel?: string; showConceptChip?: boolean; celebrationTier?: string };
    } | null;
    expect(firstBody?.attemptId).toBeTruthy();
    expect(firstBody?.eventIds?.length).toBeGreaterThan(0);
    expect(Object.keys(firstBody?.clientView ?? {}).sort()).toEqual([
      "bandLabel",
      "celebrationTier",
      "showConceptChip",
    ]);

    const replay = await call(
      submitAttemptRoute,
      `http://127.0.0.1/api/children/${childId}/attempts`,
      { id: childId },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "owner-key-0001",
          sessionId,
          itemId: "ops-g2-add",
          answer: "0",
          shownAt: "2026-04-01T00:00:00.000Z",
          submittedAt: "2026-04-01T00:00:09.000Z",
        }),
      },
    );
    expect(replay.status).toBe(200);
    expect(replay.status).not.toBe(409);
    expect(replay.body).toMatchObject({
      attemptId: firstBody?.attemptId,
      replayed: true,
      eventIds: firstBody?.eventIds,
      clientView: firstBody?.clientView,
    });
    expect(JSON.stringify(replay.body).length).toBeGreaterThan(2);
    expect(count("attempts")).toBe(1);

    const ended = await call(
      endSessionRoute,
      `http://127.0.0.1/api/children/${childId}/sessions/${sessionId}/end`,
      { id: childId, sessionId },
      { method: "POST" },
    );
    expect(ended.status).toBe(200);
    expect((ended.body as { defaultLane?: string } | null)?.defaultLane).toBe("recommended");

    const replayAfterEnd = await call(
      submitAttemptRoute,
      `http://127.0.0.1/api/children/${childId}/attempts`,
      { id: childId },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "owner-key-0001",
          sessionId,
          itemId: "ops-g2-add",
          answer: "0",
          shownAt: "2026-04-01T00:00:00.000Z",
          submittedAt: "2026-04-01T00:00:09.000Z",
        }),
      },
    );
    expect(replayAfterEnd.status).toBe(200);
    expect(replayAfterEnd.body).toMatchObject({
      attemptId: firstBody?.attemptId,
      replayed: true,
      eventIds: firstBody?.eventIds,
    });

    const chosen = await call(
      chooseLaneRoute,
      `http://127.0.0.1/api/children/${childId}/sessions/${sessionId}/lane`,
      { id: childId, sessionId },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lane: "not-a-lane" }),
      },
    );
    expect(chosen.status).toBe(200);
    expect((chosen.body as { lane?: string } | null)?.lane).toBe("recommended");
  });
});
