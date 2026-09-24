import { execFileSync } from "node:child_process";

/**
 * App build stamped beside policy_version. Resolved once when this module
 * loads (server start, via instrumentation.ts). Never empty.
 * APP_BUILD_SHA wins when it is set. Otherwise git HEAD. Otherwise unknown.
 */
function nonempty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function readGitHead(): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return nonempty(sha);
  } catch {
    return null;
  }
}

export function resolveAppBuildSha(input?: {
  env?: string;
  readGitHead?: () => string | null;
}): string {
  const envSource = input && "env" in input ? input.env : process.env.APP_BUILD_SHA;
  const fromEnv = nonempty(envSource);
  if (fromEnv) return fromEnv;
  const read = input?.readGitHead ?? readGitHead;
  try {
    const fromGit = nonempty(read() ?? undefined);
    if (fromGit) return fromGit;
  } catch {
    // git is missing or this process is not in a checkout
  }
  return "unknown";
}

export const APP_BUILD_SHA = resolveAppBuildSha();
