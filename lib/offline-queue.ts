import type { AttemptResult } from "@/lib/attempt-contract";
import { foldRewards } from "@/lib/attempt-contract";

export type QueuedAttempt = {
  idempotencyKey: string;
  childId: string;
  sessionId: string;
  itemId: string;
  answer: string;
  shownAt: string;
  submittedAt: string;
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
  | { ok: false; reason: "error"; message: string };

export type QueueSnapshot = QueueData & { lastError?: string };

const SYNCED_CAP = 40;

export function emptyQueue(): QueueData {
  return { version: 1, pending: [], blocked: [], dropped: [], synced: [] };
}

export function consentQueueReason(body: {
  error?: string;
  queueDisposition?: unknown;
} | null): "hold" | "drop" {
  const message = body?.error ?? "";
  if (body?.queueDisposition === "hold") return "hold";
  if (body?.queueDisposition === "drop") return "drop";
  if (/paused/i.test(message)) return "hold";
  if (/revoked|blocked until a parent grants/i.test(message)) return "drop";
  return "hold";
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
      const data = store.load();
      const known =
        data.pending.some((item) => item.idempotencyKey === attempt.idempotencyKey) ||
        data.synced.some((item) => item.idempotencyKey === attempt.idempotencyKey) ||
        data.blocked.some((item) => item.idempotencyKey === attempt.idempotencyKey) ||
        data.dropped.some((item) => item.idempotencyKey === attempt.idempotencyKey);
      if (!known) data.pending.push(attempt);
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
          stillPending.push(attempt);
          stopped = true;
          continue;
        }
        if (!posted.ok && posted.reason === "drop") {
          data.dropped.push(anonymize(attempt));
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
      }
      data.pending = stillPending;
      store.save(remember(data));
      return { ...store.load(), ...(lastError ? { lastError } : {}) };
    },
  };
}
