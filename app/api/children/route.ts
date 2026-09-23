import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createChild, listChildren } from "@/lib/domain";
import {
  asRecord,
  assertSameOrigin,
  errorResponse,
  optionalString,
  readJson,
  requiredString,
  requireGuardian,
} from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const guardian = await requireGuardian();
    const children = listChildren(getDb(), guardian.id);
    return NextResponse.json({ children });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const guardian = await requireGuardian();
    const body = asRecord(await readJson(request));
    const child = createChild(getDb(), guardian.id, {
      displayName: requiredString(body.displayName, "Child name"),
      timezone: optionalString(body.timezone, "Timezone"),
    });
    return NextResponse.json({ child }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
