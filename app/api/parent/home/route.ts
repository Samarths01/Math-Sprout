import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getParentHome } from "@/lib/domain";
import { errorResponse, requireGuardian } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const guardian = await requireGuardian();
    const home = getParentHome(getDb(), guardian.id);
    return NextResponse.json(home);
  } catch (error) {
    return errorResponse(error);
  }
}
