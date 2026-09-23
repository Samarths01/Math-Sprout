import type {
  BandLabel,
  CelebrationTier,
  ClientView,
  ReviewLane,
} from "@/lib/attempt-contract";

/**
 * Rules stub. One clean try is "Getting it", not "Got it".
 * The celebration tier is the one committed with the mint. This stub does not invent another.
 */
export class MasteryEstimator {
  toClientView(input: {
    correct: boolean;
    lane: ReviewLane;
    celebrationTier: CelebrationTier;
  }): ClientView {
    if (input.lane === "review" && input.celebrationTier === "full") {
      throw new Error("Review lane cannot celebrate full.");
    }
    const bandLabel: BandLabel =
      input.lane === "celebrate" && input.correct ? "Getting it" : "Still learning";
    return {
      bandLabel,
      showConceptChip: input.lane === "celebrate",
      celebrationTier: input.celebrationTier,
    };
  }
}
