import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createGuardian, createSession } from "@/lib/domain";
import {
  asRecord,
  assertSameOrigin,
  errorResponse,
  optionalString,
  readJson,
  requiredString,
  sessionCookie,
} from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = asRecord(await readJson(request));
    const db = getDb();
    const guardian = createGuardian(db, {
      email: requiredString(body.email, "Email"),
      password: requiredString(body.password, "Password"),
      timezone: optionalString(body.timezone, "Timezone"),
    });
    const token = createSession(db, guardian.id);
    const cookie = sessionCookie(request, token);
    const response = NextResponse.json({ guardian }, { status: 201 });
    response.cookies.set(cookie.name, cookie.value, cookie.options);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
