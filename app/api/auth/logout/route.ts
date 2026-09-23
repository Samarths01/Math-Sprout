import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { deleteSession } from "@/lib/domain";
import { assertSameOrigin, errorResponse, sessionCookie } from "@/lib/http";
import { SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (token) deleteSession(getDb(), token);
    const cookie = sessionCookie(request, "");
    const response = NextResponse.json({ ok: true });
    response.cookies.set(cookie.name, "", { ...cookie.options, maxAge: 0 });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
