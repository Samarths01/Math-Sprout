import type { AttemptResult } from "@/lib/attempt-contract";
import { foldRewards } from "@/lib/attempt-contract";
import { parseAnswer } from "@/lib/answer-parser";
import { interfaceCopy } from "@/lib/interface-copy";
import type { FormatRejected } from "@/lib/unparseable";

export type QueuedAttempt = {
  idempotencyKey: string;
  childId: string;
  sessionId: string;
  itemId: string;
  answer: string;
  /** When the item was shown. Captured at Check and sent unchanged on every retry. */
  shownAt: string;
  /** When the child pressed Check. Captured then and sent unchanged on every retry. */
  submittedAt: string;
  itemInstanceId?: string;
  /** Retryable sync failures so far. A parked try is no longer pending. */
  syncFailures?: number;
  /** When the first retryable sync failure happened. Offline time before this does not count. */
  firstFailedAt?: string;
};

export type BlockedAttempt = QueuedAttempt & { message: string };

/** A revoked try kept only as an id. The answer and problem are not stored. */
export type DroppedAttempt = {
  idempotencyKey: string;
  childId: string;
  sessionId: string;
};

/** A try set aside so it no longer blocks the queue. The full attempt stays local. */
export type ParkedAttempt = QueuedAttempt & { message: string };

export type QueueData = {
  version: 1;
  pending: QueuedAttempt[];
  blocked: BlockedAttempt[];
  parked: ParkedAttempt[];
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
  | { ok: false; reason: "error"; message: string }
  /** Keep the answer and stop blocking the rest of the queue. One later retry. */
  | { ok: false; reason: "park"; message: string };

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

/**
 * A retryable failure stays at the head for a few tries. The clock starts at
 * `firstFailedAt`, the first failed sync, not when the child answered. After
 * this many failures, or this long after that first failure, the try is parked
 * with the answer still stored. The next session start posts it once. One
 * server error still retries. Time spent offline before the first failure
 * does not park the try.
 */
export const QUEUE_PARK_AFTER_FAILURES = 3;
export const QUEUE_PARK_AFTER_MS = 15 * 60 * 1000;

/**
 * A parked retry posts once and must not hold session start open.
 * The post uses a timeout so a hung request cannot block session start.
 * A timeout does not say whether the server saved the answer, so the try
 * stays parked, the same as a network failure. A later replay uses the same
 * idempotency key and credits the row quietly if the server already stored it.
 */
export const QUEUE_RETRY_TIMEOUT_MS = 8_000;

/** A thrown parked-retry post stays parked. A timeout is not a drop. */
export function parkedRetryFailure(
  error: unknown,
): Extract<SyncPost, { ok: false; reason: "offline" }> {
  void error;
  return { ok: false, reason: "offline" };
}

/**
 * A queued answer that syncs leaves this item. An answer scored while online
 * stays on the feedback card until the kid chooses Next.
 */
export function advanceAfterQueuedSync(
  queuedOffline: boolean,
  synced: AttemptResult | undefined,
): AttemptResult["nextItem"] | null {
  if (!queuedOffline || !synced) return null;
  return synced.nextItem;
}

export function emptyQueue(): QueueData {
  return { version: 1, pending: [], blocked: [], parked: [], dropped: [], synced: [] };
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
 * Missing or invalid instance ids are permanent when the body names that case.
 * An unknown instance is 404 with `code: unknown_instance` and is dropped.
 * A 409 is dropped only when `savedAttempt` is true: the server already stored
 * an attempt for this item. Every other 409 is parked with the session-ended
 * message, answer kept. A missing session, a missing child, and a routing 404
 * stay retryable. 5xx stays retryable until the park limit. Other statuses
 * return null so the caller keeps its existing mapping.
 */
export function classifyAttemptFailure(
  status: number,
  body: { error?: unknown; retryable?: unknown; code?: unknown; savedAttempt?: unknown } | null,
): Extract<SyncPost, { ok: false; reason: "invalid_attempt" | "error" | "drop" | "park" }> | null {
  const unknownInstance = status === 404 && body?.code === "unknown_instance";
  if ((status === 400 && body?.error === "invalid_attempt" && body.retryable === false) || unknownInstance) {
    return { ok: false, reason: "invalid_attempt" };
  }
  if (status === 409 && body?.savedAttempt === true) {
    return { ok: false, reason: "drop", message: "" };
  }
  if (status === 409) {
    return { ok: false, reason: "park", message: interfaceCopy("offline.sessionEnded.kid") };
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

function readParked(value: unknown): ParkedAttempt[] {
  if (!Array.isArray(value)) return [];
  const parked: ParkedAttempt[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<ParkedAttempt>;
    if (typeof row.idempotencyKey !== "string" || row.idempotencyKey.length === 0) continue;
    if (
      typeof row.answer !== "string" ||
      typeof row.itemId !== "string" ||
      typeof row.shownAt !== "string" ||
      typeof row.submittedAt !== "string"
    ) {
      continue;
    }
    parked.push({
      idempotencyKey: row.idempotencyKey,
      childId: typeof row.childId === "string" ? row.childId : "",
      sessionId: typeof row.sessionId === "string" ? row.sessionId : "",
      itemId: row.itemId,
      answer: row.answer,
      shownAt: row.shownAt,
      submittedAt: row.submittedAt,
      ...(typeof row.itemInstanceId === "string" ? { itemInstanceId: row.itemInstanceId } : {}),
      ...(typeof row.syncFailures === "number" ? { syncFailures: row.syncFailures } : {}),
      ...(typeof row.firstFailedAt === "string" ? { firstFailedAt: row.firstFailedAt } : {}),
      message:
        row.message === interfaceCopy("offline.sessionEnded.kid")
          ? interfaceCopy("offline.sessionEnded.kid")
          : interfaceCopy("offline.parked.kid"),
    });
  }
  return parked;
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
          parked: readParked(parsed.parked),
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
  // reconcile and retryParkedOnce each load the queue, await the network, then
  // save the whole queue. One lock so the last save cannot drop the other's entry.
  let queueLock: Promise<void> = Promise.resolve();
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = queueLock.then(run, run);
    queueLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
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
      // One live entry per issued item. A second Check while that entry is
      // pending is ignored. The first answer stays. This guard is in the
      // queue, not only on the disabled Check button.
      const samePendingItem =
        typeof attempt.itemInstanceId === "string" &&
        attempt.itemInstanceId.length > 0 &&
        data.pending.some((item) => item.itemInstanceId === attempt.itemInstanceId);
      if (samePendingItem) return store.load();
      const known =
        data.pending.some((item) => item.idempotencyKey === attempt.idempotencyKey) ||
        data.synced.some((item) => item.idempotencyKey === attempt.idempotencyKey) ||
        data.blocked.some((item) => item.idempotencyKey === attempt.idempotencyKey) ||
        data.parked.some((item) => item.idempotencyKey === attempt.idempotencyKey) ||
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
    retryParkedOnce(
      post: (attempt: QueuedAttempt) => Promise<SyncPost>,
    ): Promise<QueueSnapshot> {
      return exclusive(async () => {
      const data = store.load();
      const stillParked: ParkedAttempt[] = [];
      let quietCredits = 0;
      const invalidAttemptKeys: string[] = [];
      for (const parked of data.parked) {
        let posted: SyncPost;
        try {
          posted = await post(parked);
        } catch {
          stillParked.push(parked);
          continue;
        }
        if (!posted.ok && (posted.reason === "offline" || posted.reason === "hold")) {
          stillParked.push(parked);
          continue;
        }
        if (!posted.ok && posted.reason === "error") {
          data.dropped.push(anonymize(parked));
          continue;
        }
        if (!posted.ok && posted.reason === "drop") {
          data.dropped.push(anonymize(parked));
          continue;
        }
        if (!posted.ok && posted.reason === "invalid_attempt") {
          data.dropped.push(anonymize(parked));
          invalidAttemptKeys.push(parked.idempotencyKey);
          warnDroppedAttempt(parked.idempotencyKey);
          continue;
        }
        if (!posted.ok && posted.reason === "format_rejected") {
          data.dropped.push(anonymize(parked));
          continue;
        }
        if (!posted.ok) {
          data.dropped.push(anonymize(parked));
          continue;
        }
        const already = data.synced.some(
          (item) =>
            item.attemptId === posted.result.attemptId ||
            item.idempotencyKey === posted.result.idempotencyKey,
        );
        if (!already) data.synced.push(posted.result);
        if (posted.result.replayed || posted.result.resumePresentation === "quiet") quietCredits += 1;
      }
      data.parked = stillParked;
      store.save(remember(data));
      return {
        ...store.load(),
        ...(quietCredits > 0 ? { quietCredits } : {}),
        ...(invalidAttemptKeys.length > 0 ? { invalidAttemptKeys } : {}),
      };
      });
    },
    reconcile(
      post: (attempt: QueuedAttempt) => Promise<SyncPost>,
      options?: { now?: string },
    ): Promise<QueueSnapshot> {
      return exclusive(async () => {
      const data = store.load();
      let lastError: string | undefined;
      const stillPending: QueuedAttempt[] = [];
      let stopped = false;
      let quietCredits = 0;
      let held = 0;
      const invalidAttemptKeys: string[] = [];
      const now = options?.now ?? new Date().toISOString();
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
        if (!posted.ok && posted.reason === "park") {
          data.parked.push({
            ...attempt,
            syncFailures: attempt.syncFailures ?? 1,
            firstFailedAt: attempt.firstFailedAt ?? now,
            message: posted.message,
          });
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
          const failures = (attempt.syncFailures ?? 0) + 1;
          const firstFailedAt = attempt.firstFailedAt ?? now;
          const ageMs = Date.parse(now) - Date.parse(firstFailedAt);
          const agedOut = Number.isFinite(ageMs) && ageMs >= QUEUE_PARK_AFTER_MS;
          const kept = { ...attempt, syncFailures: failures, firstFailedAt };
          if (failures >= QUEUE_PARK_AFTER_FAILURES || agedOut) {
            data.parked.push({ ...kept, message: interfaceCopy("offline.parked.kid") });
            continue;
          }
          stillPending.push(kept);
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
      });
    },
  };
}

let flushInFlight: Promise<QueueSnapshot> | null = null;
let flushFollowUp: (() => Promise<QueueSnapshot>) | null = null;

/**
 * One flush at a time. A trigger that arrives while a flush is running joins
 * that flush and schedules a single follow-up pass. Further triggers during
 * the same flush do not add more passes.
 */
export function runSingleFlightFlush(
  flush: () => Promise<QueueSnapshot>,
): Promise<QueueSnapshot> {
  if (flushInFlight) {
    flushFollowUp = flush;
    return flushInFlight;
  }
  let resolveFlight!: (snapshot: QueueSnapshot) => void;
  let rejectFlight!: (error: unknown) => void;
  const flight = new Promise<QueueSnapshot>((resolve, reject) => {
    resolveFlight = resolve;
    rejectFlight = reject;
  });
  flushInFlight = flight;
  void (async () => {
    try {
      let snapshot = await flush();
      while (flushFollowUp) {
        const next = flushFollowUp;
        flushFollowUp = null;
        snapshot = await next();
      }
      resolveFlight(snapshot);
    } catch (error) {
      rejectFlight(error);
    } finally {
      if (flushInFlight === flight) flushInFlight = null;
    }
  })();
  return flight;
}

export type ShownSessionAction = "start" | "reconnect" | "new-session";

/**
 * Session start, reconnect, and a new session flush queued answers and show
 * the one item the session route issued. They do not request a hidden batch.
 * Reconnect only flushes. Start and a new session retry each parked try once
 * before that flush, then open the session after the queue has drained.
 */
export async function runShownSession<T>(
  action: ShownSessionAction,
  input: {
    flush: () => Promise<QueueSnapshot>;
    retryParked?: () => Promise<QueueSnapshot>;
    openSession?: () => Promise<T>;
  },
): Promise<{ snapshot: QueueSnapshot; shown: T | null }> {
  if (action !== "reconnect" && input.retryParked) {
    await input.retryParked();
  }
  if (action === "reconnect") {
    return { snapshot: await input.flush(), shown: null };
  }
  if (!input.openSession) throw new Error("A shown session needs an opener.");
  const drained = await issueAfterQueueDrain(input.flush, input.openSession);
  return { snapshot: drained.snapshot, shown: drained.issued };
}

/**
 * A batch issue can supersede items a queued try still belongs to.
 * Reconcile first. Issuance runs only after the queue has drained. Entries
 * that reconcile drops or parks are not pending, so they do not block the
 * next batch. A retryable try still under the park limit does.
 */
export async function issueAfterQueueDrain<T>(
  reconcile: () => Promise<QueueSnapshot>,
  issue: () => Promise<T>,
): Promise<{ snapshot: QueueSnapshot; issued: T | null }> {
  const snapshot = await reconcile();
  if (snapshot.pending.length > 0) return { snapshot, issued: null };
  return { snapshot, issued: await issue() };
}
