import { execFile as nodeExecFile } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";

/**
 * Build tag stamped beside policy_version.
 * APP_BUILD_SHA, when set, wins for the process and git is never spawned.
 * Otherwise a save reads the cache. currentAppBuildSha() starts a background
 * refresh only when the HEAD stamp changed or the TTL expired. There is no
 * standing timer.
 *
 * A save made within about 5 seconds of a git pull may record the previous SHA.
 * That lag is accepted: the refresh stays lazy and a save never waits on git.
 */
const DIRTY_TTL_MS = 5_000;
const GIT_TIMEOUT_MS = 1_500;
const GIT_MAX_BUFFER = 16 * 1024;

function nonempty(value: string | undefined | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export type BuildResolverDeps = {
  env: () => string | undefined;
  /** Background git describe. Not awaited by current(). */
  describe: () => Promise<string | null>;
  headStamp: () => string | null;
  now: () => number;
  ttlMs?: number;
};

export function createBuildResolver(deps: BuildResolverDeps) {
  const ttl = deps.ttlMs ?? DIRTY_TTL_MS;
  let cache: { value: string; stamp: string | null; at: number } | null = null;
  let inflight: Promise<void> | null = null;
  let generation = 0;

  function pinnedEnv(): string | null {
    return nonempty(deps.env());
  }

  function snapshotStamp(): string | null {
    try {
      return deps.headStamp();
    } catch {
      return null;
    }
  }

  function stale(now: number): boolean {
    if (!cache) return true;
    if (cache.stamp !== snapshotStamp()) return true;
    return now - cache.at >= ttl;
  }

  function rememberFailure(gen: number) {
    if (gen !== generation) return;
    cache = {
      value: cache?.value ?? "unknown",
      stamp: snapshotStamp(),
      at: deps.now(),
    };
  }

  function refresh(): Promise<void> {
    if (pinnedEnv()) return Promise.resolve();
    if (inflight) return inflight;
    if (!stale(deps.now())) return Promise.resolve();
    const gen = generation;
    const work = (async () => {
      const stamp = snapshotStamp();
      const at = deps.now();
      const next = nonempty(await deps.describe());
      if (gen !== generation) return;
      cache = { value: next ?? cache?.value ?? "unknown", stamp, at };
    })();
    inflight = work
      .catch(() => {
        rememberFailure(gen);
      })
      .finally(() => {
        if (gen === generation) inflight = null;
      });
    return inflight;
  }

  return {
    /**
     * Cached tag. A changed HEAD stamp or an expired TTL starts one background
     * refresh and this returns immediately. A save within about 5 seconds of a
     * git pull may still record the previous SHA. That lag is accepted.
     */
    current(): string {
      const pinned = pinnedEnv();
      if (pinned) return pinned;
      if (stale(deps.now())) void refresh();
      return cache?.value ?? "unknown";
    },
    refresh,
    clear() {
      generation += 1;
      cache = null;
      inflight = null;
    },
  };
}

type GitExecOptions = {
  cwd?: string;
  timeout?: number;
  killSignal?: NodeJS.Signals;
  maxBuffer?: number;
  encoding?: "utf8";
};

type GitExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

/** Process calls the resolver uses. Tests replace these to mock git and the HEAD files. */
export const buildCommands = {
  execFile(
    file: string,
    args: readonly string[],
    options: GitExecOptions,
    callback: GitExecCallback,
  ) {
    nodeExecFile(file, args as string[], options, (error, stdout, stderr) => {
      callback(error, String(stdout ?? ""), String(stderr ?? ""));
    });
  },
  statSync: fs.statSync.bind(fs) as typeof fs.statSync,
  readFileSync: fs.readFileSync.bind(fs) as typeof fs.readFileSync,
};

const gitTimers = new Set<ReturnType<typeof setTimeout>>();
const gitCancels = new Set<() => void>();

function gitOutput(args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (error: Error | null, value: string | null) => {
      if (settled) return;
      settled = true;
      gitCancels.delete(cancel);
      if (timer) {
        clearTimeout(timer);
        gitTimers.delete(timer);
        timer = null;
      }
      if (error) reject(error);
      else resolve(value);
    };
    const cancel = () => finish(null, null);
    gitCancels.add(cancel);
    timer = setTimeout(() => finish(null, null), GIT_TIMEOUT_MS);
    timer.unref();
    gitTimers.add(timer);
    try {
      buildCommands.execFile(
        "git",
        args,
        {
          cwd: process.cwd(),
          timeout: GIT_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: GIT_MAX_BUFFER,
          encoding: "utf8",
        },
        (error, stdout) => {
          finish(error, error ? null : nonempty(stdout));
        },
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)), null);
    }
  });
}

let gitDirPath: string | null = null;
let gitDirPromise: Promise<void> | null = null;

/** One async `rev-parse --git-dir`. Never called from the request path. */
function ensureGitDir(): Promise<void> {
  if (!gitDirPromise) {
    gitDirPromise = gitOutput(["rev-parse", "--git-dir"])
      .then((dir) => {
        gitDirPath = dir ? path.resolve(process.cwd(), dir) : null;
      })
      .catch(() => {
        gitDirPath = null;
      });
  }
  return gitDirPromise;
}

export function readGitDescribe(): Promise<string | null> {
  return gitOutput(["describe", "--always", "--dirty", "--abbrev=12"]);
}

/** Cheap local read of HEAD. Skips the filesystem until the git dir is known. */
export function readHeadStamp(): string | null {
  try {
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

/** Tag to store on a new attempt or practice session. Never waits on git. */
export function currentAppBuildSha(): string {
  return live.current();
}

/**
 * One non-blocking refresh. When APP_BUILD_SHA is set, git is not spawned.
 * Resolves the git dir here, then describes. Never rejects.
 */
export function primeAppBuildSha(): Promise<void> {
  if (nonempty(process.env.APP_BUILD_SHA)) return Promise.resolve();
  return ensureGitDir()
    .then(() => live.refresh())
    .catch(() => undefined);
}

/** Join or start the background describe. Never rejects. */
export function refreshAppBuildSha(): Promise<void> {
  return live.refresh().catch(() => undefined);
}

/** Drop in-flight git work so a test does not leave Node or Vitest waiting. */
export function stopBuildShaRefresh(): void {
  live.clear();
  for (const timer of gitTimers) clearTimeout(timer);
  gitTimers.clear();
  for (const cancel of [...gitCancels]) cancel();
  gitCancels.clear();
  gitDirPath = null;
  gitDirPromise = null;
}

export function resetBuildCacheForTests(): void {
  stopBuildShaRefresh();
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
