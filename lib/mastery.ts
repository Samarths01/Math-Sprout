import type {
  BandLabel,
  CelebrationTier,
  ClientView,
  ReviewLane,
} from "@/lib/attempt-contract";

/**
 * Practice lane chosen at a session boundary. This is not the Slice 2
 * integrity lane (`celebrate` | `review`).
 */
export const PRACTICE_LANES = ["recommended", "challenge", "review"] as const;

export type PracticeLane = (typeof PRACTICE_LANES)[number];

export const PROGRESSION_DECISIONS = ["stay", "remediate", "levelUpSlight"] as const;

export type ProgressionDecision = (typeof PROGRESSION_DECISIONS)[number];

/** Recent attempts that can move a chip. Older than this drop out of the window. */
export const EVIDENCE_WINDOW = 6;

/** Recommended or Challenge successes required before Got it or LevelUpSlight. */
export const GOT_IT_QUALIFYING = 3;

/** Careful misses inside the window that ask for a smaller next step. */
export const REMEDIATE_MISSES = 2;

export const DEFAULT_PRACTICE_LANE: PracticeLane = "recommended";

/**
 * One stored try. `lane` is the Slice 2 integrity lane. `practiceLane` is the
 * session lane. Omitted practice lane means Recommended, which is the default
 * for attempts recorded before a lane was chosen.
 */
export type SkillEvidence = {
  correct: boolean;
  lane: ReviewLane;
  practiceLane?: PracticeLane;
};

export type ClientViewInput = {
  correct: boolean;
  lane: ReviewLane;
  celebrationTier: CelebrationTier;
  practiceLane?: PracticeLane;
  /** Older evidence for this skill, oldest first. The current try is appended. */
  history?: readonly SkillEvidence[];
};

export type BoundaryLaneOption = {
  lane: PracticeLane;
  label: "Recommended" | "Challenge" | "Review";
  isDefault: boolean;
  available: boolean;
  /** Skills still short of Got it. Present on the Review option. */
  remaining?: number;
};

/** Lane menu at SessionBoundary. SetBoundary is not part of this slice. */
export type BoundaryOptions = {
  sessionId: string;
  atBoundary: true;
  boundary: "session";
  defaultLane: "recommended";
  progression: ProgressionDecision;
  levelUpSlight: boolean;
  focusSkill: string;
  clientView: ClientView;
  options: BoundaryLaneOption[];
};

export type WindowAssessment = {
  bandLabel: BandLabel;
  progression: ProgressionDecision;
  qualifying: number;
};

export function parsePracticeLane(value: unknown): PracticeLane | null {
  if (value === "recommended" || value === "challenge" || value === "review") {
    return value;
  }
  return null;
}

/** Unknown or missing lanes use Recommended, the default. They do not become Review. */
export function practiceLaneOrRecommended(value: unknown): PracticeLane {
  return parsePracticeLane(value) ?? DEFAULT_PRACTICE_LANE;
}

/**
 * A qualifying success is a careful correct try on Recommended or Challenge.
 * Review-lane tries never qualify, so they cannot mint Got it or LevelUpSlight.
 */
export function isQualifyingEvidence(item: SkillEvidence): boolean {
  const practiceLane = item.practiceLane ?? DEFAULT_PRACTICE_LANE;
  return (
    item.correct &&
    item.lane === "celebrate" &&
    (practiceLane === "recommended" || practiceLane === "challenge")
  );
}

export function assessWindow(evidence: readonly SkillEvidence[]): WindowAssessment {
  const window = evidence.slice(-EVIDENCE_WINDOW);
  const qualifying = window.filter(isQualifyingEvidence).length;
  const cleanCorrect = window.filter(
    (item) => item.correct && item.lane === "celebrate",
  ).length;
  const celebrateMisses = window.filter(
    (item) => !item.correct && item.lane === "celebrate",
  ).length;
  const latest = window[window.length - 1];
  const latestMiss = Boolean(latest && !latest.correct && latest.lane === "celebrate");
  const gotIt = qualifying >= GOT_IT_QUALIFYING && !latestMiss;

  const bandLabel: BandLabel = gotIt
    ? "Got it"
    : cleanCorrect >= 1
      ? "Getting it"
      : "Still learning";

  let progression: ProgressionDecision = "stay";
  if (gotIt) progression = "levelUpSlight";
  else if (celebrateMisses >= REMEDIATE_MISSES) progression = "remediate";

  if (progression === "levelUpSlight" && qualifying < GOT_IT_QUALIFYING) {
    progression = "stay";
  }

  return { bandLabel, progression, qualifying };
}

/**
 * Rules estimator. One clean try is "Getting it". "Got it" and LevelUpSlight
 * need Recommended or Challenge evidence inside the window.
 */
export interface MasteryEstimator {
  toClientView(input: ClientViewInput): ClientView;
  decideProgression(evidence: readonly SkillEvidence[]): ProgressionDecision;
}

class RulesMasteryEstimator implements MasteryEstimator {
  toClientView(input: ClientViewInput): ClientView {
    if (input.lane === "review" && input.celebrationTier === "full") {
      throw new Error("Review lane cannot celebrate full.");
    }
    const current: SkillEvidence = {
      correct: input.correct,
      lane: input.lane,
      practiceLane: input.practiceLane ?? DEFAULT_PRACTICE_LANE,
    };
    const assessment = assessWindow([...(input.history ?? []), current]);
    if (assessment.bandLabel === "Got it" && assessment.qualifying < GOT_IT_QUALIFYING) {
      throw new Error("Got it requires recommended or challenge evidence.");
    }
    return {
      bandLabel: assessment.bandLabel,
      showConceptChip: input.lane === "celebrate",
      celebrationTier: input.celebrationTier,
    };
  }

  decideProgression(evidence: readonly SkillEvidence[]): ProgressionDecision {
    const assessment = assessWindow(evidence);
    if (
      assessment.progression === "levelUpSlight" &&
      assessment.qualifying < GOT_IT_QUALIFYING
    ) {
      throw new Error("LevelUpSlight requires recommended or challenge evidence.");
    }
    return assessment.progression;
  }
}

/** Rules implementation. The constructor name matches the Slice 2 attempt path. */
export const MasteryEstimator = RulesMasteryEstimator;
