import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getChildHome } from "@/lib/domain";
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
    const home = getChildHome(getDb(), guardian.id, id);
    return NextResponse.json(home);
  } catch (error) {
    return errorResponse(error);
  }
}
