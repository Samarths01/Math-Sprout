"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import type { AttemptResult, ClientView, PublicItem } from "@/lib/attempt-contract";
import type { BoundaryOptions, PracticeLane } from "@/lib/mastery";
import { itemAt, ITEM_CATALOG } from "@/lib/item-catalog";
import { interfaceCopy } from "@/lib/interface-copy";
import { PracticeFeedback } from "@/components/practice-feedback";
import {
  consentQueueReason,
  createAttemptQueue,
  OFFLINE_QUEUE_CAP,
  storageQueueStore,
  type QueuedAttempt,
  type SyncPost,
} from "@/lib/offline-queue";
import { showResumeCelebration } from "@/lib/pause-hold";
import { postPauseHoldUntilVisible } from "@/lib/pause-hold-receipt";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [item, setItem] = useState<PublicItem | null>(null);
  const [shownAt, setShownAt] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<AttemptResult | null>(null);
  const [savedOffline, setSavedOffline] = useState(false);
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
    if (snapshot.quietCredits) setQuietResume(true);
    if (snapshot.held) setHeldNotice(true);
    if (waitingKey.current) {
      const synced = snapshot.synced.find(
        (result) => result.idempotencyKey === waitingKey.current,
      );
      if (synced && showResumeCelebration(synced)) {
        setFeedback(synced);
        setSavedOffline(false);
        setHeldNotice(false);
        waitingKey.current = null;
      } else if (synced) {
        setFeedback(null);
        setQuietResume(true);
        setSavedOffline(false);
        setHeldNotice(false);
        waitingKey.current = null;
      }
    }
    if (snapshot.lastError) setError(snapshot.lastError);
    await publishOfflineCap(snapshot.pending.length);
    return snapshot;
  }

  async function publishOfflineCap(waiting: number): Promise<void> {
    try {
      await fetch(`/api/children/${childId}/offline-cap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ waiting }),
      });
    } catch {
      // The try stays on this focus. A later flush retries the parent receipt.
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
        setShownAt(new Date().toISOString());
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

  function showNext(next: PublicItem) {
    waitingKey.current = null;
    setItem(next);
    setShownAt(new Date().toISOString());
    setAnswer("");
    setFeedback(null);
    setSavedOffline(false);
    setError(null);
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
      setSessionId(body.sessionId);
      setItem(body.item);
      setPersistedView(body.clientView ?? null);
      setBoundary(null);
      setFeedback(null);
      setAnswer("");
      setShownAt(new Date().toISOString());
      setSavedOffline(false);
    } catch {
      setError("That lane is not available.");
    }
    setBusy(false);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!sessionId || !item || !shownAt || busy) return;
    setBusy(true);
    setError(null);
    if (queue().snapshot().pending.length >= OFFLINE_QUEUE_CAP) {
      setPending(OFFLINE_QUEUE_CAP);
      await publishOfflineCap(OFFLINE_QUEUE_CAP);
      setBusy(false);
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
    };
    waitingKey.current = idempotencyKey;
    queue().enqueue(queued);
    const snapshot = await flush();
    const synced = snapshot.synced.find((result) => result.idempotencyKey === idempotencyKey);
    if (synced && showResumeCelebration(synced)) {
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

  if (!item) {
    return <p className="text-sm text-muted-foreground">Getting a problem ready…</p>;
  }

  const nextFromFeedback = feedback?.nextItem;
  const localNext = itemAt(ITEM_CATALOG.findIndex((entry) => entry.id === item.id) + 1);
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
      {persistedView && !boundary && !feedback ? (
        <p data-testid="persisted-band" data-band-label={persistedView.bandLabel}>
          {persistedView.bandLabel}
          {persistedView.showConceptChip ? ` · ${item.skill}` : ""}
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
      <Card>
        <CardHeader>
          <CardDescription>
            Grade {item.grade} · {item.pack === "fractions" ? "Fractions" : "Operations"}
          </CardDescription>
          <CardTitle
            data-testid="practice-prompt"
            className="font-heading text-3xl leading-tight"
          >
            {item.prompt}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {feedback ? (
            <div data-testid="practice-feedback" className="grid gap-4" aria-live="polite">
              <PracticeFeedback feedback={feedback} item={item} />
              {offlineCapped ? null : (
                <Button
                  type="button"
                  className="h-12 text-base"
                  onClick={() => showNext(nextFromFeedback ?? localNext)}
                >
                  Next problem
                </Button>
              )}
            </div>
          ) : (
            <form className="grid gap-3" onSubmit={onSubmit}>
              {savedOffline && !offlineCapped ? (
                <p role="status" className="text-sm leading-6">
                  Saved on this device. It will check in when you reconnect.
                </p>
              ) : null}
              <div className="grid gap-2">
                <Label htmlFor="practice-answer">Your answer</Label>
                <Input
                  id="practice-answer"
                  data-testid="practice-answer"
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  autoComplete="off"
                  className="h-12 text-lg"
                />
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <Button
                type="submit"
                data-testid="practice-submit"
                disabled={busy || offlineCapped}
                className="h-12 text-base"
              >
                {busy ? "Checking…" : "Check answer"}
              </Button>
              {savedOffline && !offlineCapped ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-12 text-base"
                  onClick={() => showNext(localNext)}
                >
                  Next problem
                </Button>
              ) : null}
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
