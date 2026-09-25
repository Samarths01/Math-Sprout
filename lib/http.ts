import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { DomainError, guardianFromSession, type Guardian } from "@/lib/domain";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/session";

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new DomainError("Request body must be JSON.", 400);
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("Request body must be a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError(`${label} is required.`, 400);
  }
  return value;
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new DomainError(`${label} must be a string.`, 400);
  }
  return value;
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new DomainError("Cross-origin request blocked.", 403);
  }
  const host = request.headers.get("host");
  if (!host || originHost !== host) {
    throw new DomainError("Cross-origin request blocked.", 403);
  }
}

function cookieSecure(request: Request): boolean {
  if (process.env.COOKIE_SECURE === "true") return true;
  if (process.env.COOKIE_SECURE === "false") return false;
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() === "https";
  }
  return false;
}

export function sessionCookie(request: Request, token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      sameSite: "lax" as const,
      path: "/",
      secure: cookieSecure(request),
      maxAge: SESSION_MAX_AGE_SECONDS,
    },
  };
}

export async function currentGuardian(): Promise<Guardian | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return guardianFromSession(getDb(), token);
}

export async function requireGuardian(): Promise<Guardian> {
  const guardian = await currentGuardian();
  if (!guardian) throw new DomainError("Sign in required.", 401);
  return guardian;
}

export function publicErrorBody(error: unknown): {
  status: number;
  body: {
    error: string;
    retryable?: false;
    queueDisposition?: "hold" | "drop";
    code?: string;
    savedAttempt?: true;
  };
} {
  if (error instanceof DomainError && error.permanentCode === "invalid_attempt") {
    return { status: 400, body: { error: "invalid_attempt", retryable: false } };
  }
  if (error instanceof DomainError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.code === "session_ended" ? { retryable: false as const } : {}),
        ...(error.savedAttempt ? { savedAttempt: true as const } : {}),
        ...(error.queueDisposition ? { queueDisposition: error.queueDisposition } : {}),
      },
    };
  }
  console.error(error);
  return { status: 500, body: { error: "Something went wrong." } };
}

export function errorResponse(error: unknown): NextResponse {
  const mapped = publicErrorBody(error);
  return NextResponse.json(mapped.body, { status: mapped.status });
}
