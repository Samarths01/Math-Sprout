import type { WrongFormReason } from "@/lib/wrong-form-copy";

export const FOUR_BEAT_KEYS = [
  "whatWentWell",
  "oneFocus",
  "tryNext",
  "lockIn",
] as const;

export type FourBeatKey = (typeof FOUR_BEAT_KEYS)[number];

export type FourBeat = Record<FourBeatKey, string>;

/** Practice renders this server string as sent. No local rewrite and no model line. */
export function displayedOneFocus(beat: Pick<FourBeat, "oneFocus">): string {
  return beat.oneFocus;
}

export type IntegrityFlag = "empty_answer" | "too_fast" | "spam_window" | "unparseable";

export type ReviewLane = "celebrate" | "review";

/** Plan §2.3. `full` is the former sprout mint, not a BuildGoal. */
export type CelebrationTier = "none" | "quietXp" | "full";

export const BAND_LABELS = ["Still learning", "Getting it", "Got it"] as const;

export type BandLabel = (typeof BAND_LABELS)[number];

export type ClientView = {
  bandLabel: BandLabel;
  showConceptChip: boolean;
  celebrationTier: CelebrationTier;
};

export type ItemPack = "operations" | "fractions";

export type PublicItem = {
  id: string;
  pack: ItemPack;
  grade: 2 | 3 | 4;
  skill: string;
  prompt: string;
  /** Kid-facing difficulty word for this item's own step. */
  stepWord?: "Warm-up" | "Steady" | "Stretch";
  itemInstanceId?: string;
  layout?: "inline" | "column";
  blankInline?: { leading: string; trailing: string };
  columnLines?: string[];
  /** Server-chosen. The client does not compute this from the answer. */
  answerKind?: "whole" | "fraction";
  /** A hint example that is not the canonical answer. */
  formatExample?: string;
};

/**
 * Fuel this attempt minted. Every id is a QualifyingEvent on the bus.
 * `credit` is accrue-only: it is never negative, and a replay repeats it.
 */
export type AttemptFuel = {
  credit: number;
  heatEventId: string | null;
  pieceEventIds: string[];
};

export type AttemptResult = FourBeat & {
  attemptId: string;
  idempotencyKey: string;
  replayed: boolean;
  correct: boolean;
  celebrationTier: CelebrationTier;
  lane: ReviewLane;
  flags: IntegrityFlag[];
  /** QualifyingEvent ids for this attempt. XP credits point at these ids. */
  eventIds: string[];
  xpAmount: number;
  /** Heat, XP, and build pieces from this attempt's qualifying events. */
  fuel: AttemptFuel;
  clientView: ClientView;
  nextItem: PublicItem;
  /**
   * Set when this try was held across pause. The mint still stands.
   * Callers must not present a celebration for a quiet resume.
   */
  resumePresentation?: "quiet";
  /**
   * Child-safe form note. Present only when the amount matched and the
   * written form did not. `null` when this attempt has no form frozen on
   * its item instance. The stored outcome tag stays off this object.
   */
  reason?: WrongFormReason | null;
};

export const TOO_FAST_MS = 500;
export const SPAM_WINDOW_MS = 10_000;

/**
 * Counted response time for one try, in milliseconds.
 * Latency is `submittedAt` minus `shownAt`. Both are captured on the device
 * when the child presses Check and are stored on the attempt. The server
 * does not use the time it receives the request.
 * One try counts at most 120 seconds. The parent-summary minutes rule uses
 * this same constant, so the two cannot drift. A longer span is clamped.
 * The attempt is still saved and can still count toward the band.
 * A negative or non-finite span counts as 0, which the too-fast flag treats
 * as too fast.
 */
export const ATTEMPT_LATENCY_CAP_MS = 120_000;

/**
 * A device Check time may lead the server clock, or trail the item's
 * `issued_at`, by this much. `submittedAt` also picks the XP and streak day,
 * the spam window, and evidence order, so a time outside this window is
 * rejected rather than clamped.
 */
export const SUBMITTED_AT_SKEW_MS = 2 * 60_000;

export function responseLatencyMs(shownAt: string, submittedAt: string): number {
  const raw = Date.parse(submittedAt) - Date.parse(shownAt);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  if (raw > ATTEMPT_LATENCY_CAP_MS) return ATTEMPT_LATENCY_CAP_MS;
  return raw;
}
/** Earlier attempts allowed inside the window before the next one is spam. */
export const SPAM_MAX_IN_WINDOW = 8;

export const XP_AMOUNT: Record<CelebrationTier, number> = {
  none: 0,
  quietXp: 1,
  full: 5,
};

/** `elapsedMs` is `responseLatencyMs`: the capped device span, not receipt time. */
export function integrityFlags(input: {
  answer: string;
  elapsedMs: number;
  priorInWindow: number;
}): IntegrityFlag[] {
  const flags: IntegrityFlag[] = [];
  if (input.answer.trim().length === 0) flags.push("empty_answer");
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < TOO_FAST_MS) {
    flags.push("too_fast");
  }
  if (input.priorInWindow >= SPAM_MAX_IN_WINDOW) flags.push("spam_window");
  return flags;
}

/**
 * Integrity classification only. The QualifyingEvent bus is the only XP mint.
 * This review lane is the integrity lane (empty, too-fast, spam): quietXp or none.
 * A clean correct try is a full candidate; the bus may still reduce it.
 */
export function resolveCelebration(input: {
  correct: boolean;
  flags: readonly IntegrityFlag[];
}): { lane: ReviewLane; celebrationTier: CelebrationTier; xpAmount: number } {
  if (input.flags.length > 0) {
    const spamOnly = input.flags.every((flag) => flag === "spam_window");
    const celebrationTier: CelebrationTier = spamOnly ? "quietXp" : "none";
    return {
      lane: "review",
      celebrationTier,
      xpAmount: XP_AMOUNT[celebrationTier],
    };
  }
  const celebrationTier: CelebrationTier = input.correct ? "full" : "quietXp";
  return {
    lane: "celebrate",
    celebrationTier,
    xpAmount: XP_AMOUNT[celebrationTier],
  };
}

export function foldRewards(results: AttemptResult[]): {
  eventIds: string[];
  totalXp: number;
} {
  const seen = new Set<string>();
  const eventIds: string[] = [];
  let totalXp = 0;
  for (const result of results) {
    const fresh = result.eventIds.filter((id) => !seen.has(id));
    if (fresh.length === 0) continue;
    for (const id of fresh) {
      seen.add(id);
      eventIds.push(id);
    }
    totalXp += result.xpAmount;
  }
  return { eventIds, totalXp };
}
