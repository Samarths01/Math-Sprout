import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { readPauseHold, registerPauseHold, type PauseHoldAttempt } from "@/lib/pause-hold";
import {
  asRecord,
  assertSameOrigin,
  errorResponse,
  readJson,
  requireGuardian,
} from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const guardian = await requireGuardian();
    const { id } = await context.params;
    const hold = readPauseHold(getDb(), guardian.id, id);
    return NextResponse.json(hold ?? { visible: false, waiting: 0 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const guardian = await requireGuardian();
    const { id } = await context.params;
    const body = asRecord(await readJson(request));
    const attempt: PauseHoldAttempt = {
      idempotencyKey: String(body.idempotencyKey ?? ""),
      sessionId: String(body.sessionId ?? ""),
      itemId: String(body.itemId ?? ""),
      answer: typeof body.answer === "string" ? body.answer : "",
      shownAt: String(body.shownAt ?? ""),
      submittedAt: String(body.submittedAt ?? ""),
    };
    const hold = registerPauseHold(getDb(), guardian.id, id, attempt);
    return NextResponse.json(hold);
  } catch (error) {
    return errorResponse(error);
  }
}
