import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { errorResponse, requireGuardian } from "@/lib/http";
import { readParentSummary } from "@/lib/parent-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const guardian = await requireGuardian();
    const { id } = await context.params;
    const summary = readParentSummary(getDb(), guardian.id, id);
    return NextResponse.json(summary);
  } catch (error) {
    return errorResponse(error);
  }
}
