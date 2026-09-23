import { NextResponse } from "next/server";
import { readCompanion } from "@/lib/companion";
import { getDb } from "@/lib/db";
import { getChild } from "@/lib/domain";
import { errorResponse, requireGuardian } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const guardian = await requireGuardian();
    const { id } = await context.params;
    getChild(getDb(), guardian.id, id);
    const companion = readCompanion(getDb(), id, new Date().toISOString());
    return NextResponse.json(companion);
  } catch (error) {
    return errorResponse(error);
  }
}
