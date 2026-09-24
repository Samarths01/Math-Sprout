import { NextResponse } from "next/server";
import { parseSubmitAttempt, submitAnswer } from "@/lib/attempts";
import { getDb } from "@/lib/db";
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

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const guardian = await requireGuardian();
    const { id } = await context.params;
    const body = asRecord(await readJson(request));
    const result = submitAnswer(
      getDb(),
      guardian.id,
      id,
      parseSubmitAttempt(body),
    );
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
