import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";

/**
 * Build tag stamped beside policy_version.
 * APP_BUILD_SHA, when set at startup, is kept for the process (deployed builds).
 * Otherwise each attempt and session insert resolves
 * `git describe --always --dirty --abbrev=12`, cached until `.git/HEAD`
 * or the ref it points at changes, and refreshed about every 5s so a dirty
 * tree shows up without spawning git on every request. Never throws.
 */
const DIRTY_TTL_MS = 5_000;

function nonempty(value: string | undefined | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export type BuildResolverDeps = {
  env: () => string | undefined;
  describe: () => string | null;
  headStamp: () => string | null;
  now: () => number;
  ttlMs?: number;
};

export function createBuildResolver(deps: BuildResolverDeps) {
  const startupEnv = nonempty(deps.env());
  const ttl = deps.ttlMs ?? DIRTY_TTL_MS;
  let cache: { value: string; stamp: string | null; at: number } | null = null;

  function current(): string {
    if (startupEnv) return startupEnv;
    let stamp: string | null = null;
    try {
      stamp = deps.headStamp();
    } catch {
      stamp = null;
    }
    const now = deps.now();
    if (cache && cache.stamp === stamp && now - cache.at < ttl) return cache.value;
    let value = "unknown";
    try {
      value = nonempty(deps.describe()) ?? "unknown";
    } catch {
      value = "unknown";
    }
    cache = { value, stamp, at: now };
    return value;
  }

  return {
    current,
    clear() {
      cache = null;
    },
  };
}

/** Process calls the resolver uses. Tests replace these to mock git and the HEAD files. */
export const buildCommands = {
  execFileSync: childProcess.execFileSync.bind(childProcess) as typeof childProcess.execFileSync,
  statSync: fs.statSync.bind(fs) as typeof fs.statSync,
  readFileSync: fs.readFileSync.bind(fs) as typeof fs.readFileSync,
};

function gitOutput(args: string[]): string | null {
  try {
    const out = String(
      buildCommands.execFileSync("git", args, {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      }),
    ).trim();
    return nonempty(out);
  } catch {
    return null;
  }
}

let gitDirPath: string | null | undefined;

export function readGitDescribe(): string | null {
  return gitOutput(["describe", "--always", "--dirty", "--abbrev=12"]);
}

export function readHeadStamp(): string | null {
  try {
    if (gitDirPath === undefined) {
      const dir = gitOutput(["rev-parse", "--git-dir"]);
      gitDirPath = dir ? path.resolve(process.cwd(), dir) : null;
    }
    if (!gitDirPath) return null;
    const headPath = path.join(gitDirPath, "HEAD");
    const headStat = buildCommands.statSync(headPath);
    let stamp = String(headStat.mtimeMs);
    const head = String(buildCommands.readFileSync(headPath, "utf8")).trim();
    const ref = head.match(/^ref:\s+(.+)$/);
    if (ref) {
      stamp += `:${buildCommands.statSync(path.join(gitDirPath, ref[1])).mtimeMs}`;
    }
    return stamp;
  } catch {
    return null;
  }
}

const live = createBuildResolver({
  env: () => process.env.APP_BUILD_SHA,
  describe: readGitDescribe,
  headStamp: readHeadStamp,
  now: () => Date.now(),
});

/** Tag to store on a new attempt or practice session. */
export function currentAppBuildSha(): string {
  return live.current();
}

export function resetBuildCacheForTests(): void {
  gitDirPath = undefined;
  live.clear();
}

/**
 * One warning when the tag is unknown. Does not throw in dev or production.
 * Names APP_BUILD_SHA so a non-git deploy can see why rows drop out of before/after analysis.
 */
export function warnIfBuildUnknown(sha = currentAppBuildSha()): void {
  if (sha !== "unknown") return;
  console.warn(
    "APP_BUILD_SHA is unset and git could not name this build. Before/after analysis will exclude these rows.",
  );
}

/** Parent-home footer. A long hex sha is shortened; a dirty git tag keeps -dirty. */
export function formatParentBuildLabel(sha: string): string {
  const dirty = sha.endsWith("-dirty");
  const core = dirty ? sha.slice(0, -"-dirty".length) : sha;
  const short = /^[0-9a-f]{13,}$/i.test(core) ? core.slice(0, 12) : core;
  return `Build ${short}${dirty ? "-dirty" : ""}`;
}
