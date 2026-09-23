import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { authenticate, createSession } from "@/lib/domain";
import {
  asRecord,
  assertSameOrigin,
  errorResponse,
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
    const guardian = authenticate(db, {
      email: requiredString(body.email, "Email"),
      password: requiredString(body.password, "Password"),
    });
    const token = createSession(db, guardian.id);
    const cookie = sessionCookie(request, token);
    const response = NextResponse.json({ guardian });
    response.cookies.set(cookie.name, cookie.value, cookie.options);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
