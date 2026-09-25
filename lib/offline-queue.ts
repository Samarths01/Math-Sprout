import type { AttemptResult } from "@/lib/attempt-contract";
import { foldRewards } from "@/lib/attempt-contract";
import { parseAnswer } from "@/lib/answer-parser";
import type { FormatRejected } from "@/lib/unparseable";

export type QueuedAttempt = {
  idempotencyKey: string;
  childId: string;
  sessionId: string;
  itemId: string;
  answer: string;
  shownAt: string;
  submittedAt: string;
  itemInstanceId?: string;
};

export type BlockedAttempt = QueuedAttempt & { message: string };

/** A revoked try kept only as an id. The answer and problem are not stored. */
export type DroppedAttempt = {
  idempotencyKey: string;
  childId: string;
  sessionId: string;
};

export type QueueData = {
  version: 1;
  pending: QueuedAttempt[];
  blocked: BlockedAttempt[];
  dropped: DroppedAttempt[];
  synced: AttemptResult[];
};

export type QueueStore = {
  load: () => QueueData;
  save: (data: QueueData) => void;
};

export type SyncPost =
  | { ok: true; result: AttemptResult }
  | { ok: false; reason: "offline" }
  | { ok: false; reason: "hold"; message: string }
  | { ok: false; reason: "drop"; message: string }
  | { ok: false; reason: "format_rejected"; rejected: FormatRejected }
  | { ok: false; reason: "invalid_attempt" }
  | { ok: false; reason: "error"; message: string };

export type QueueSnapshot = QueueData & {
  lastError?: string;
  /** Tries credited on this pass with quiet resume. They must not celebrate. */
  quietCredits?: number;
  /** Tries kept on this pass because a parent-visible pause hold was recorded. */
  held?: number;
  /** A new try was refused because the unsynced queue is already at the cap. */
  capped?: boolean;
  /** An unreadable answer was not queued. It is not an attempt. */
  formatRejected?: boolean;
  /** Queued tries dropped this pass because the server will never accept them. */
  invalidAttemptKeys?: string[];
};

const SYNCED_CAP = 40;

/**
 * Short unsynced queue. Architecture §24 offline guard (a).
 * Further tries wait until these sync. Frozen next-item is not this seam.
 */
export const OFFLINE_QUEUE_CAP = 3;

export function emptyQueue(): QueueData {
  return { version: 1, pending: [], blocked: [], dropped: [], synced: [] };
}

/**
 * Kid-path disposition for a 403.
 * Pause is hold only: parent-visible waiting, then a quiet resume.
 * There is no drop-on-pause path. Revoke and missing consent drop.
 */
export function consentQueueReason(
  body: { error?: string; queueDisposition?: unknown } | null,
): "hold" | "drop" {
  if (body?.queueDisposition === "hold") return "hold";
  return "drop";
}

/**
 * Missing or invalid instance ids are permanent. 5xx stays retryable.
 * Other statuses return null so the caller keeps its existing mapping.
 */
export function classifyAttemptFailure(
  status: number,
  body: { error?: unknown; retryable?: unknown } | null,
): Extract<SyncPost, { ok: false; reason: "invalid_attempt" | "error" }> | null {
  if (status === 400 && body?.error === "invalid_attempt" && body.retryable === false) {
    return { ok: false, reason: "invalid_attempt" };
  }
  if (status >= 500) {
    return {
      ok: false,
      reason: "error",
      message: typeof body?.error === "string" ? body.error : "Could not save that try.",
    };
  }
  return null;
}

/** Dev console only. The argument is the idempotency key, never the answer. */
export function warnDroppedAttempt(idempotencyKey: string): void {
  if (process.env.NODE_ENV === "production") return;
  console.warn(`Dropped queued attempt ${idempotencyKey}`);
}

/** A live tab reloads when the try it is waiting on can never sync. */
export function reloadLiveSession(
  waitingKey: string | null,
  snapshot: QueueSnapshot,
  reload: () => void,
): boolean {
  if (!waitingKey || !snapshot.invalidAttemptKeys?.includes(waitingKey)) return false;
  reload();
  return true;
}

function anonymize(attempt: QueuedAttempt): DroppedAttempt {
  return {
    idempotencyKey: attempt.idempotencyKey,
    childId: attempt.childId,
    sessionId: attempt.sessionId,
  };
}

function readDropped(value: unknown): DroppedAttempt[] {
  if (!Array.isArray(value)) return [];
  const dropped: DroppedAttempt[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<QueuedAttempt>;
    if (typeof row.idempotencyKey !== "string" || row.idempotencyKey.length === 0) continue;
    dropped.push({
      idempotencyKey: row.idempotencyKey,
      childId: typeof row.childId === "string" ? row.childId : "",
      sessionId: typeof row.sessionId === "string" ? row.sessionId : "",
    });
  }
  return dropped;
}

export function memoryQueueStore(initial?: QueueData): QueueStore {
  let data = structuredClone(initial ?? emptyQueue());
  return {
    load: () => structuredClone(data),
    save: (next) => {
      data = structuredClone(next);
    },
  };
}

export function storageQueueStore(
  storage: Pick<Storage, "getItem" | "setItem">,
  storageKey: string,
): QueueStore {
  return {
    load() {
      const raw = storage.getItem(storageKey);
      if (!raw) return emptyQueue();
      try {
        const parsed = JSON.parse(raw) as Partial<QueueData>;
        if (parsed.version !== 1 || !Array.isArray(parsed.pending)) return emptyQueue();
        return {
          version: 1,
          pending: parsed.pending,
          blocked: [],
          dropped: [
            ...readDropped(parsed.dropped),
            ...readDropped(parsed.blocked),
          ],
          synced: Array.isArray(parsed.synced) ? parsed.synced : [],
        };
      } catch {
        return emptyQueue();
      }
    },
    save(data) {
      storage.setItem(storageKey, JSON.stringify(data));
    },
  };
}

function remember(data: QueueData): QueueData {
  return {
    ...data,
    synced: data.synced.slice(-SYNCED_CAP),
  };
}

export function createAttemptQueue(store: QueueStore) {
  return {
    snapshot(): QueueSnapshot {
      return store.load();
    },
    rewards() {
      return foldRewards(store.load().synced);
    },
    enqueue(attempt: QueuedAttempt): QueueSnapshot {
      if (parseAnswer(attempt.answer).kind === "unparseable") {
        return { ...store.load(), formatRejected: true };
      }
      const data = store.load();
      const known =
        data.pending.some((item) => item.idempotencyKey === attempt.idempotencyKey) ||
        data.synced.some((item) => item.idempotencyKey === attempt.idempotencyKey) ||
        data.blocked.some((item) => item.idempotencyKey === attempt.idempotencyKey) ||
        data.dropped.some((item) => item.idempotencyKey === attempt.idempotencyKey);
      if (!known) {
        if (data.pending.length >= OFFLINE_QUEUE_CAP) {
          return { ...store.load(), capped: true };
        }
        data.pending.push(attempt);
      }
      store.save(remember(data));
      return store.load();
    },
    async reconcile(
      post: (attempt: QueuedAttempt) => Promise<SyncPost>,
    ): Promise<QueueSnapshot> {
      const data = store.load();
      let lastError: string | undefined;
      const stillPending: QueuedAttempt[] = [];
      let stopped = false;
      let quietCredits = 0;
      let held = 0;
      const invalidAttemptKeys: string[] = [];
      for (const attempt of data.pending) {
        if (stopped) {
          stillPending.push(attempt);
          continue;
        }
        let posted: SyncPost;
        try {
          posted = await post(attempt);
        } catch {
          stillPending.push(attempt);
          stopped = true;
          lastError = "Could not reach Math Sprout.";
          continue;
        }
        if (!posted.ok && posted.reason === "offline") {
          stillPending.push(attempt);
          stopped = true;
          continue;
        }
        if (!posted.ok && posted.reason === "hold") {
          // Visible hold only. Keep walking so every waiting try can be registered.
          // Resume credits these later and does not dump a celebration.
          stillPending.push(attempt);
          held += 1;
          continue;
        }
        if (!posted.ok && posted.reason === "drop") {
          data.dropped.push(anonymize(attempt));
          continue;
        }
        if (!posted.ok && posted.reason === "format_rejected") {
          continue;
        }
        if (!posted.ok && posted.reason === "invalid_attempt") {
          data.dropped.push(anonymize(attempt));
          invalidAttemptKeys.push(attempt.idempotencyKey);
          warnDroppedAttempt(attempt.idempotencyKey);
          continue;
        }
        if (!posted.ok) {
          stillPending.push(attempt);
          stopped = true;
          lastError = posted.message;
          continue;
        }
        const already = data.synced.some(
          (item) =>
            item.attemptId === posted.result.attemptId ||
            item.idempotencyKey === posted.result.idempotencyKey,
        );
        if (!already) data.synced.push(posted.result);
        if (posted.result.resumePresentation === "quiet") quietCredits += 1;
      }
      data.pending = stillPending;
      store.save(remember(data));
      return {
        ...store.load(),
        ...(lastError ? { lastError } : {}),
        ...(quietCredits > 0 ? { quietCredits } : {}),
        ...(held > 0 ? { held } : {}),
        ...(invalidAttemptKeys.length > 0 ? { invalidAttemptKeys } : {}),
      };
    },
  };
}
