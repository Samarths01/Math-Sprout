import { NextResponse } from "next/server";
import { startPracticeSession } from "@/lib/attempts";
import { getDb } from "@/lib/db";
import { assertSameOrigin, errorResponse, requireGuardian } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const guardian = await requireGuardian();
    const { id } = await context.params;
    const session = startPracticeSession(getDb(), guardian.id, id);
    return NextResponse.json(session);
  } catch (error) {
    return errorResponse(error);
  }
}
