import { NextResponse } from "next/server";
import { getBoundaryOptions } from "@/lib/boundary";
import { getDb } from "@/lib/db";
import { errorResponse, requireGuardian } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; sessionId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const guardian = await requireGuardian();
    const { id, sessionId } = await context.params;
    const options = getBoundaryOptions(getDb(), guardian.id, id, sessionId);
    return NextResponse.json(options);
  } catch (error) {
    return errorResponse(error);
  }
}
