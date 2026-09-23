export const FOUR_BEAT_KEYS = [
  "whatWentWell",
  "oneFocus",
  "tryNext",
  "lockIn",
] as const;

export type FourBeatKey = (typeof FOUR_BEAT_KEYS)[number];

export type FourBeat = Record<FourBeatKey, string>;

/** Practice renders this server string as sent. Do not substitute local praise. */
export function displayedOneFocus(beat: Pick<FourBeat, "oneFocus">): string {
  return beat.oneFocus;
}

export type IntegrityFlag = "empty_answer" | "too_fast" | "spam_window";

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
  clientView: ClientView;
  nextItem: PublicItem;
  /**
   * Set when this try was held across pause. The mint still stands.
   * Callers must not present a celebration for a quiet resume.
   */
  resumePresentation?: "quiet";
};

export const TOO_FAST_MS = 500;
export const SPAM_WINDOW_MS = 10_000;
/** Earlier attempts allowed inside the window before the next one is spam. */
export const SPAM_MAX_IN_WINDOW = 8;

export const XP_AMOUNT: Record<CelebrationTier, number> = {
  none: 0,
  quietXp: 1,
  full: 5,
};

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
