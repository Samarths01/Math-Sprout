import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getConsent, parseConsentAction, setConsent } from "@/lib/domain";
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
    const consent = getConsent(getDb(), guardian.id, id);
    return NextResponse.json(consent);
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
    const action = parseConsentAction(body.action);
    const consent = setConsent(getDb(), guardian.id, id, action);
    return NextResponse.json(consent);
  } catch (error) {
    return errorResponse(error);
  }
}
