import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { DomainError, getChild } from "@/lib/domain";
import { asRecord, assertSameOrigin, errorResponse, readJson, requireGuardian } from "@/lib/http";
import { readPracticeSession } from "@/lib/learner-state";
import { itemAt } from "@/lib/item-catalog";
import { ISSUE_BATCH_CAP, issueItemBatch, toPublicItem } from "@/lib/templates/issue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; sessionId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const guardian = await requireGuardian();
    const { id, sessionId } = await context.params;
    const body = asRecord(await readJson(request));
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    if (idempotencyKey.length < 8) {
      throw new DomainError("Idempotency key is required.", 400);
    }
    const count = body.count === undefined ? 1 : body.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > ISSUE_BATCH_CAP) {
      throw new DomainError("A practice batch can hold at most 3 problems.", 400);
    }
    const db = getDb();
    getChild(db, guardian.id, id);
    const session = readPracticeSession(db, id, sessionId);
    if (!session) throw new DomainError("Practice session not found.", 404);
    const instances = issueItemBatch(db, {
      childId: id,
      sessionId,
      idempotencyKey,
      count,
      itemIndex: session.item_index,
    });
    return NextResponse.json({
      items: instances.map((instance, index) => toPublicItem(itemAt(session.item_index + index), instance)),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
