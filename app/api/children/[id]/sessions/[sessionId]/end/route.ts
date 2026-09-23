import { NextResponse } from "next/server";
import { endPracticeSession } from "@/lib/boundary";
import { getDb } from "@/lib/db";
import { assertSameOrigin, errorResponse, requireGuardian } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; sessionId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const guardian = await requireGuardian();
    const { id, sessionId } = await context.params;
    const options = endPracticeSession(getDb(), guardian.id, id, sessionId);
    return NextResponse.json(options);
  } catch (error) {
    return errorResponse(error);
  }
}
