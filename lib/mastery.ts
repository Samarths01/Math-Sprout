import type { ClientView, ReviewLane } from "@/lib/attempt-contract";

/**
 * Rules stub for the child-facing soft state.
 * It does not emit a score, a percent, or a confidence value.
 */
export class MasteryEstimator {
  view(input: { correct: boolean; lane: ReviewLane }): ClientView {
    if (input.lane === "review") {
      return {
        softState: "needs-review",
        line: "We'll keep this try quiet and practice another.",
      };
    }
    if (input.correct) {
      return {
        softState: "steady",
        line: "This skill looks steady for now.",
      };
    }
    return {
      softState: "sprouting",
      line: "This skill is still sprouting. One focus is enough.",
    };
  }
}
