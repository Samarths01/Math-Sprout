"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import type { AttemptResult, ClientView, PublicItem } from "@/lib/attempt-contract";
import type { BoundaryOptions, PracticeLane } from "@/lib/mastery";
import { interfaceCopy } from "@/lib/interface-copy";
import { PracticeFeedback } from "@/components/practice-feedback";
import {
  classifyAttemptFailure,
  consentQueueReason,
  createAttemptQueue,
  OFFLINE_QUEUE_CAP,
  reloadLiveSession,
  storageQueueStore,
  type QueueSnapshot,
  type QueuedAttempt,
  type SyncPost,
} from "@/lib/offline-queue";
import { markFuelPulse } from "@/lib/fuel-motion";
import { showResumeCelebration } from "@/lib/pause-hold";
import { postPauseHoldUntilVisible } from "@/lib/pause-hold-receipt";
import { AnswerBlank } from "@/components/answer-blank";
import { PracticeProblem } from "@/components/practice-problem";
import { parseAnswer } from "@/lib/answer-parser";
import { provisionalVerdict } from "@/lib/provisional-verdict";
import {
  FORMAT_EXAMPLE_DEFAULTS,
  formatHint as formatHintCopy,
  isFormatRejected,
  type AnswerKind,
} from "@/lib/unparseable";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";

/** A stalled parent receipt is the same as being offline. */
export const OFFLINE_CAP_TIMEOUT_MS = 8_000;

function answerKindOf(item: PublicItem): AnswerKind {
  return item.answerKind === "fraction" ? "fraction" : "whole";
}

function offlineFormatHint(item: PublicItem): string {
  const kind = answerKindOf(item);
  return formatHintCopy(kind, item.formatExample ?? FORMAT_EXAMPLE_DEFAULTS[kind]);
}

const PROGRESS_COPY: Record<BoundaryOptions["progression"], string> = {
  stay: "Recommended stays the usual next step.",
  remediate: "The next set can stay with what is still shaky.",
  levelUpSlight: "A little harder is ready for next time.",
};

type SessionStart = {
  sessionId?: string;
  item?: PublicItem;
  lane?: PracticeLane;
  atBoundary?: boolean;
  clientView?: ClientView | null;
  error?: string;
};

async function postAttempt(childId: string, attempt: QueuedAttempt): Promise<SyncPost> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ok: false, reason: "offline" };
  }
  try {
    const response = await fetch(`/api/children/${childId}/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(attempt),
    });
    const body = (await response.json().catch(() => null)) as
      | (AttemptResult & { error?: string; queueDisposition?: unknown })
      | null;
    if (isFormatRejected(body)) {
      return { ok: false, reason: "format_rejected", rejected: body };
    }
    const classified = classifyAttemptFailure(response.status, body);
    if (classified) return classified;
    if (response.status === 403) {
      if (body?.queueDisposition === "hold") {
        // Receipt retries stay on hold. A failed POST never becomes a drop.
        await registerVisibleHold(childId, attempt);
      }
      return {
        ok: false,
        reason: consentQueueReason(body),
        message: body?.error ?? "Practice is blocked.",
      };
    }
    if (!response.ok || !body || typeof body.attemptId !== "string") {
      return {
        ok: false,
        reason: "error",
        message: body?.error ?? "Could not save that try.",
      };
    }
    return { ok: true, result: body };
  } catch {
    return { ok: false, reason: "offline" };
  }
}

type TurnCommand =
  | { type: "result"; result: AttemptResult }
  | { type: "quiet" };

type MountedTurn = {
  instanceId: string;
  apply: (command: TurnCommand) => void;
};

/**
 * One problem's answer and result. PracticeSession mounts a fresh turn for
 * each item instance, so a Check answer that resolves after Next cannot
 * leave the previous Correct/Not yet card on the next stem.
 */
function PracticeTurn({
  childId,
  sessionId,
  item,
  offlineCapped,
  error,
  persistedView,
  busy,
  armWaiting,
  registerTurn,
  releaseTurn,
  setBusy,
  setError,
  setPersistedView,
  setQuietResume,
  setHeldNotice,
  onAdvance,
  onEndSession,
  onOfflineCap,
  queue,
  flush,
}: {
  childId: string;
  sessionId: string;
  item: PublicItem;
  offlineCapped: boolean;
  error: string | null;
  persistedView: ClientView | null;
  busy: boolean;
  armWaiting: (instanceId: string, idempotencyKey: string) => void;
  registerTurn: (turn: MountedTurn) => void;
  releaseTurn: (turn: MountedTurn) => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  setPersistedView: (view: ClientView) => void;
  setQuietResume: (quiet: boolean) => void;
  setHeldNotice: (held: boolean) => void;
  onAdvance: (next: PublicItem) => void;
  onEndSession: () => void;
  onOfflineCap: (waiting: number) => Promise<void>;
  queue: () => ReturnType<typeof createAttemptQueue>;
  flush: () => Promise<QueueSnapshot>;
}) {
  const instanceId = item.itemInstanceId ?? item.id;
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<AttemptResult | null>(null);
  const [savedOffline, setSavedOffline] = useState(false);
  const [formatHint, setFormatHint] = useState<string | null>(null);
  const [formatLocked, setFormatLocked] = useState(false);
  // After a reload the response-time clock starts when the item is shown again.
  // The 2-minute cap covers edge cases.
  const [shownAt] = useState(() => new Date().toISOString());

  useLayoutEffect(() => {
    const turn: MountedTurn = {
      instanceId,
      apply(command) {
        if (command.type === "result") {
          setFeedback(command.result);
          setSavedOffline(false);
          return;
        }
        setFeedback(null);
        setSavedOffline(false);
      },
    };
    registerTurn(turn);
    return () => {
      releaseTurn(turn);
    };
  }, [instanceId, registerTurn, releaseTurn]);

  function editAnswer(next: string) {
    setAnswer(next);
    if (next !== answer) setFormatHint(null);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!shownAt || busy || formatLocked) return;
    setBusy(true);
    setError(null);
    try {
      if (parseAnswer(answer).kind === "unparseable") {
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        if (!offline && item.itemInstanceId) {
          const posted = await postAttempt(childId, {
            idempotencyKey: crypto.randomUUID(),
            childId,
            sessionId,
            itemId: item.id,
            answer,
            shownAt,
            submittedAt: new Date().toISOString(),
            itemInstanceId: item.itemInstanceId,
          });
          if (!posted.ok && posted.reason === "format_rejected") {
            setFormatHint(posted.rejected.hint);
            setFormatLocked(posted.rejected.behavior === "lock");
            setFeedback(null);
            setSavedOffline(false);
            return;
          }
        }
        setFormatHint(offlineFormatHint(item));
        setFeedback(null);
        setSavedOffline(false);
        return;
      }
      setFormatHint(null);
      if (queue().snapshot().pending.length >= OFFLINE_QUEUE_CAP) {
        await onOfflineCap(OFFLINE_QUEUE_CAP);
        return;
      }
      const idempotencyKey = crypto.randomUUID();
      const queued: QueuedAttempt = {
        idempotencyKey,
        childId,
        sessionId,
        itemId: item.id,
        answer,
        shownAt,
        submittedAt: new Date().toISOString(),
        ...(item.itemInstanceId ? { itemInstanceId: item.itemInstanceId } : {}),
      };
      armWaiting(instanceId, idempotencyKey);
      queue().enqueue(queued);
      const snapshot = await flush();
      const synced = snapshot.synced.find((result) => result.idempotencyKey === idempotencyKey);
      if (synced && showResumeCelebration(synced)) {
        markFuelPulse(window.sessionStorage, childId, {
          tier: synced.clientView.celebrationTier,
          credit: synced.fuel.credit,
          eventCount: synced.eventIds.length,
          replayed: synced.replayed,
          resumeQuiet: false,
          eventId: synced.eventIds[0] ?? null,
        });
        setFeedback(synced);
        setPersistedView(synced.clientView);
        setSavedOffline(false);
        setHeldNotice(false);
      } else if (synced) {
        setFeedback(null);
        setPersistedView(synced.clientView);
        setQuietResume(true);
        setSavedOffline(false);
        setHeldNotice(false);
      } else if (snapshot.pending.some((entry) => entry.idempotencyKey === idempotencyKey)) {
        setSavedOffline(!snapshot.held);
        setHeldNotice(Boolean(snapshot.held));
        setFeedback(null);
      }
    } finally {
      setBusy(false);
    }
  }

  const nextFromFeedback = feedback?.nextItem;
  const pendingVerdict = provisionalVerdict();

  return (
    <>
      {persistedView && !feedback ? (
        <p data-testid="persisted-band" data-band-label={persistedView.bandLabel}>
          {persistedView.bandLabel}
          {persistedView.showConceptChip ? ` · ${item.skill}` : ""}
        </p>
      ) : null}
      <Card>
        <CardHeader>
          <PracticeProblem
            item={item}
            answerSlot={
              item.blankInline && !feedback ? (
                <AnswerBlank
                  value={answer}
                  hint={formatHint}
                  answerKind={answerKindOf(item)}
                  locked={formatLocked}
                  disabled={formatLocked}
                  onValueChange={editAnswer}
                  form="practice-form"
                  className="h-12 w-24 text-center font-heading text-2xl tabular-nums"
                />
              ) : undefined
            }
          />
        </CardHeader>
        <CardContent>
          {feedback ? (
            <div data-testid="practice-feedback" className="grid gap-4" aria-live="polite">
              <PracticeFeedback feedback={feedback} item={item} />
              {offlineCapped ? null : (
                <Button
                  type="button"
                  size="primary"
                  disabled={busy}
                  onClick={() => {
                    if (nextFromFeedback) onAdvance(nextFromFeedback);
                  }}
                >
                  Next problem
                </Button>
              )}
            </div>
          ) : (
            <form id="practice-form" className="grid gap-3" noValidate onSubmit={onSubmit}>
              {savedOffline && !offlineCapped ? (
                <p
                  role="status"
                  data-testid="provisional-verdict"
                  data-pending={pendingVerdict.pending ? "true" : "false"}
                  data-reveals-answer={pendingVerdict.revealsAnswer ? "true" : "false"}
                  data-mints={pendingVerdict.mints ? "true" : "false"}
                  className="text-sm leading-6"
                >
                  Saved on this device. It will check in when you reconnect.
                </p>
              ) : null}
              {item.blankInline ? null : (
                <div className="grid gap-2">
                  <Label htmlFor="practice-answer">Your answer</Label>
                  <AnswerBlank
                    value={answer}
                    hint={formatHint}
                    answerKind={answerKindOf(item)}
                    locked={formatLocked}
                    disabled={formatLocked}
                    onValueChange={editAnswer}
                    className="h-12 text-lg"
                  />
                </div>
              )}
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <Button
                type="submit"
                size="primary"
                data-testid="practice-submit"
                disabled={busy || offlineCapped || formatLocked}
              >
                {busy ? "Checking…" : "Check answer"}
              </Button>
            </form>
          )}
          <Button
            type="button"
            variant="outline"
            className="mt-4 h-12 text-base"
            data-testid="end-session"
            disabled={busy}
            onClick={() => void onEndSession()}
          >
            End session
          </Button>
        </CardContent>
      </Card>
    </>
  );
}

async function registerVisibleHold(childId: string, attempt: QueuedAttempt): Promise<boolean> {
  return postPauseHoldUntilVisible(async () => {
    const response = await fetch(`/api/children/${childId}/pause-hold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(attempt),
    });
    const body = (await response.json().catch(() => null)) as { visible?: boolean } | null;
    return response.ok && body?.visible === true;
  });
}

export function PracticeSession({
  childId,
  displayName,
}: {
  childId: string;
  displayName: string;
}) {
  const queueRef = useRef<ReturnType<typeof createAttemptQueue> | null>(null);
  const waitingKey = useRef<string | null>(null);
  const waitingInstanceId = useRef<string | null>(null);
  const turnRef = useRef<MountedTurn | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [item, setItem] = useState<PublicItem | null>(null);
  const [heldNotice, setHeldNotice] = useState(false);
  const [quietResume, setQuietResume] = useState(false);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [boundary, setBoundary] = useState<BoundaryOptions | null>(null);
  const [persistedView, setPersistedView] = useState<ClientView | null>(null);

  function queue() {
    if (!queueRef.current) {
      queueRef.current = createAttemptQueue(
        storageQueueStore(window.localStorage, `math-sprout-attempt-queue:${childId}`),
      );
    }
    return queueRef.current;
  }

  async function flush() {
    const snapshot = await queue().reconcile((attempt) => postAttempt(childId, attempt));
    setPending(snapshot.pending.length);
    if (reloadLiveSession(waitingKey.current, snapshot, () => window.location.reload())) {
      return snapshot;
    }
    if (snapshot.quietCredits) setQuietResume(true);
    if (snapshot.held) setHeldNotice(true);
    if (waitingKey.current) {
      const synced = snapshot.synced.find(
        (result) => result.idempotencyKey === waitingKey.current,
      );
      const turn =
        turnRef.current && turnRef.current.instanceId === waitingInstanceId.current
          ? turnRef.current
          : null;
      if (synced && showResumeCelebration(synced)) {
        markFuelPulse(window.sessionStorage, childId, {
          tier: synced.clientView.celebrationTier,
          credit: synced.fuel.credit,
          eventCount: synced.eventIds.length,
          replayed: synced.replayed,
          resumeQuiet: false,
          eventId: synced.eventIds[0] ?? null,
        });
        turn?.apply({ type: "result", result: synced });
        setHeldNotice(false);
        waitingKey.current = null;
        waitingInstanceId.current = null;
      } else if (synced) {
        turn?.apply({ type: "quiet" });
        setQuietResume(true);
        setHeldNotice(false);
        waitingKey.current = null;
        waitingInstanceId.current = null;
      }
    }
    if (snapshot.lastError) setError(snapshot.lastError);
    await publishOfflineCap(snapshot.pending.length);
    return snapshot;
  }

  async function publishOfflineCap(waiting: number): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OFFLINE_CAP_TIMEOUT_MS);
    try {
      await fetch(`/api/children/${childId}/offline-cap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ waiting }),
        signal: controller.signal,
      });
    } catch {
      // A timeout or abort is the same as offline: the receipt may not have
      // landed. The try stays on this focus. A later flush retries it.
    } finally {
      clearTimeout(timer);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        const response = await fetch(`/api/children/${childId}/sessions`, {
          method: "POST",
        });
        const body = (await response.json().catch(() => null)) as SessionStart | null;
        if (!response.ok || !body?.sessionId || !body.item) {
          if (!cancelled) {
            await flush();
            setError(body?.error ?? "Practice could not start.");
          }
          return;
        }
        if (cancelled) return;
        setSessionId(body.sessionId);
        setItem(body.item);
        setPersistedView(body.clientView ?? null);
        setReady(true);
        if (body.atBoundary) {
          const options = await fetch(
            `/api/children/${childId}/sessions/${body.sessionId}/boundary-options`,
          );
          const menu = (await options.json().catch(() => null)) as
            | (BoundaryOptions & { error?: string })
            | null;
          if (!cancelled && options.ok && menu && menu.atBoundary) setBoundary(menu);
        } else if (!cancelled) {
          setBoundary(null);
        }
        const snapshot = queue().snapshot();
        setPending(snapshot.pending.length);
        if (snapshot.pending.length > 0) await flush();
      } catch {
        if (!cancelled) setError("Practice could not start.");
      }
    }
    void start();
    const onOnline = () => {
      void flush();
    };
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
    };
    // flush closes over the latest waiting key via a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childId]);

  const armWaiting = useCallback((instanceId: string, idempotencyKey: string) => {
    waitingInstanceId.current = instanceId;
    waitingKey.current = idempotencyKey;
  }, []);

  const registerTurn = useCallback((turn: MountedTurn) => {
    turnRef.current = turn;
  }, []);

  const releaseTurn = useCallback((turn: MountedTurn) => {
    if (turnRef.current === turn) turnRef.current = null;
  }, []);

  function showNext(next: PublicItem) {
    waitingKey.current = null;
    waitingInstanceId.current = null;
    setItem(next);
    setError(null);
  }

  async function noteOfflineCap(waiting: number) {
    setPending(waiting);
    await publishOfflineCap(waiting);
  }

  async function onEndSession() {
    if (!sessionId || busy) return;
    setBusy(true);
    setError(null);
    await flush();
    try {
      const response = await fetch(`/api/children/${childId}/sessions/${sessionId}/end`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as
        | (BoundaryOptions & { error?: string })
        | null;
      if (!response.ok || !body?.atBoundary) {
        setError(body?.error ?? "This session is not ready to end.");
        setBusy(false);
        return;
      }
      setBoundary(body);
      setPersistedView(body.clientView);
    } catch {
      setError("This session is not ready to end.");
    }
    setBusy(false);
  }

  async function onChooseLane(lane: PracticeLane) {
    if (!sessionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const choice = await fetch(`/api/children/${childId}/sessions/${sessionId}/lane`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lane }),
      });
      const chosen = (await choice.json().catch(() => null)) as { error?: string } | null;
      if (!choice.ok) {
        setError(chosen?.error ?? "That lane is not available.");
        setBusy(false);
        return;
      }
      const response = await fetch(`/api/children/${childId}/sessions`, { method: "POST" });
      const body = (await response.json().catch(() => null)) as SessionStart | null;
      if (!response.ok || !body?.sessionId || !body.item) {
        setError(body?.error ?? "Practice could not start.");
        setBusy(false);
        return;
      }
      waitingKey.current = null;
      waitingInstanceId.current = null;
      setSessionId(body.sessionId);
      setItem(body.item);
      setPersistedView(body.clientView ?? null);
      setBoundary(null);
    } catch {
      setError("That lane is not available.");
    }
    setBusy(false);
  }

  if (error && !ready) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="font-heading text-2xl">Practice is closed</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm leading-6">{error}</p>
          {heldNotice ? (
            <p data-testid="pause-hold-kid" role="status" className="text-sm leading-6">
              {interfaceCopy("pause.hold.kid")}
            </p>
          ) : null}
          {quietResume ? (
            <p
              data-testid="quiet-resume"
              data-presentation="quiet"
              role="status"
              className="text-sm leading-6"
            >
              {interfaceCopy("pause.resume.quiet")}
            </p>
          ) : null}
          {pending >= OFFLINE_QUEUE_CAP ? (
            <p
              data-testid="offline-queue-cap"
              data-cap={OFFLINE_QUEUE_CAP}
              data-pattern="calm-wait"
              role="status"
              className="text-sm leading-6"
            >
              {interfaceCopy("offline.cap.kid")}
            </p>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  if (!item || !sessionId) {
    return <p className="text-sm text-muted-foreground">Getting a problem ready…</p>;
  }

  const offlineCapped = pending >= OFFLINE_QUEUE_CAP;

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <p className="text-sm text-muted-foreground">Hi, {displayName}</p>
        <h1 className="font-heading text-4xl tracking-tight">Practice</h1>
      </div>
      <p data-testid="sync-status" className="text-sm text-muted-foreground">
        {pending > 0
          ? `${pending} ${pending === 1 ? "answer is" : "answers are"} waiting to sync.`
          : "Saved answers sync with the practice record."}
      </p>
      {quietResume ? (
        <p
          data-testid="quiet-resume"
          data-presentation="quiet"
          role="status"
          className="text-sm leading-6"
        >
          {interfaceCopy("pause.resume.quiet")}
        </p>
      ) : null}
      {heldNotice && !quietResume ? (
        <p data-testid="pause-hold-kid" role="status" className="text-sm leading-6">
          {interfaceCopy("pause.hold.kid")}
        </p>
      ) : null}
      {offlineCapped ? (
        <p
          data-testid="offline-queue-cap"
          data-cap={OFFLINE_QUEUE_CAP}
          data-pattern="calm-wait"
          role="status"
          className="text-sm leading-6"
        >
          {interfaceCopy("offline.cap.kid")}
        </p>
      ) : null}
      {boundary ? (
        <Card
          data-testid="boundary-options"
          data-review-sessions-remaining={boundary.reviewSessionsRemaining}
        >
          <CardHeader>
            <CardTitle className="font-heading text-2xl">Pick the next set</CardTitle>
            <CardDescription data-testid="boundary-progression">
              {PROGRESS_COPY[boundary.progression]}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p data-testid="boundary-band" data-band-label={boundary.clientView.bandLabel}>
              {boundary.clientView.bandLabel}
              {boundary.clientView.showConceptChip ? ` · ${boundary.focusSkill}` : ""}
            </p>
            {boundary.options.map((option) => (
              <Button
                key={option.lane}
                type="button"
                variant={option.isDefault ? "default" : "outline"}
                className="h-12 text-base"
                data-testid={`lane-${option.lane}`}
                data-default-lane={option.isDefault ? "true" : "false"}
                disabled={busy || !option.available}
                onClick={() => void onChooseLane(option.lane)}
              >
                {option.label}
                {option.lane === "review" && option.remaining
                  ? ` · ${option.remaining} still going`
                  : ""}
                {option.lane === "review" && typeof option.sessionsRemaining === "number"
                  ? ` · ${option.sessionsRemaining} left this week`
                  : ""}
                {option.isDefault ? " · usual" : ""}
              </Button>
            ))}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </CardContent>
        </Card>
      ) : (
        <PracticeTurn
          key={item.itemInstanceId ?? item.id}
          childId={childId}
          sessionId={sessionId}
          item={item}
          offlineCapped={offlineCapped}
          error={error}
          persistedView={persistedView}
          busy={busy}
          armWaiting={armWaiting}
          registerTurn={registerTurn}
          releaseTurn={releaseTurn}
          setBusy={setBusy}
          setError={setError}
          setPersistedView={setPersistedView}
          setQuietResume={setQuietResume}
          setHeldNotice={setHeldNotice}
          onAdvance={showNext}
          onEndSession={() => void onEndSession()}
          onOfflineCap={noteOfflineCap}
          queue={queue}
          flush={flush}
        />
      )}
      <Link
        href={`/child/${childId}`}
        className="text-sm text-primary underline-offset-4 hover:underline"
      >
        Back to child home
      </Link>
    </div>
  );
}
