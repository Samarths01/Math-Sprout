import { NextResponse } from "next/server";
import { errorResponse, requireGuardian } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const guardian = await requireGuardian();
    return NextResponse.json({ guardian });
  } catch (error) {
    return errorResponse(error);
  }
}
