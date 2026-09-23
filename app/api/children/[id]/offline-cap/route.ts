import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { DomainError } from "@/lib/domain";
import { readOfflineCap, registerOfflineCap } from "@/lib/offline-cap";
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
    const cap = readOfflineCap(getDb(), guardian.id, id);
    return NextResponse.json(cap ?? { visible: false, waiting: 0 });
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
    if (typeof body.waiting !== "number" || !Number.isInteger(body.waiting) || body.waiting < 0) {
      throw new DomainError("Waiting count must be a whole number.", 400);
    }
    const cap = registerOfflineCap(getDb(), guardian.id, id, body.waiting);
    return NextResponse.json(cap);
  } catch (error) {
    return errorResponse(error);
  }
}
