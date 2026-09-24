import { execFile as nodeExecFile } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";

/**
 * Build tag stamped beside policy_version.
 * APP_BUILD_SHA, when set at startup, is kept for the process and git is never spawned.
 * Otherwise a background refresh runs `git describe --always --dirty --abbrev=12`.
 * The request path only reads the cache. A refresh that fails keeps the last known tag.
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
  const startupEnv = nonempty(deps.env());
  const ttl = deps.ttlMs ?? DIRTY_TTL_MS;
  let cache: { value: string; stamp: string | null; at: number } | null = null;
  let inflight: Promise<void> | null = null;
  let generation = 0;

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

  function refresh(): Promise<void> {
    if (startupEnv) return Promise.resolve();
    if (inflight) return inflight;
    if (!stale(deps.now())) return Promise.resolve();
    const gen = generation;
    inflight = (async () => {
      const stamp = snapshotStamp();
      const at = deps.now();
      let next: string | null = null;
      try {
        next = nonempty(await deps.describe());
      } catch {
        next = null;
      }
      if (gen !== generation) return;
      cache = { value: next ?? cache?.value ?? "unknown", stamp, at };
    })()
      .catch(() => {
        /* A refresh never rejects. The last known tag stays in place. */
      })
      .finally(() => {
        if (gen === generation) inflight = null;
      });
    return inflight;
  }

  return {
    /** Cached tag. Starts at most one background refresh and never waits on it. */
    current(): string {
      if (startupEnv) return startupEnv;
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

function gitOutput(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), GIT_TIMEOUT_MS);
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
          finish(error ? null : nonempty(stdout));
        },
      );
    } catch {
      finish(null);
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

export function resetBuildCacheForTests(): void {
  gitDirPath = null;
  gitDirPromise = null;
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
