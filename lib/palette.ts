import type { StreakState } from "@/lib/streak";

/**
 * Shared presentation palette. Progress and verdict colors on the child
 * surfaces read these tokens. Heat and flame-run rules do not live here.
 * Green is the Correct verdict and the logo mark.
 */
export const PALETTE = {
  flame: {
    hot: "#E4572E",
    warm: "#F29E4C",
    ember: "#B5651D",
    resting: "#9AA0A6",
  },
  xp: "#E8B923",
  piece: "#7C5CBF",
  verdict: {
    correct: "#2E9E5B",
    miss: "#4A7FC1",
  },
  ink: "#1F2A44",
  logo: "#2E9E5B",
  /** Beat labels and quiet captions. */
  label: "#5B6475",
  paper: "#FBF8F1",
  /** Neutral slate. Index 0 is the lightest step. */
  step: ["#E4E7EC", "#C5CAD3", "#9AA3B2", "#6B7382", "#3E4654"] as const,
} as const;

/** Former forest-green primary. Buttons and progress must not use it. */
export const OLD_BRAND_GREEN = "oklch(0.42 0.09 155)";

export const FLAME_CLASS: Record<StreakState, string> = {
  hot: "text-flame-hot",
  warm: "text-flame-warm",
  ember: "text-flame-ember",
  dormant: "text-flame-resting",
};

/** 12% tint chip plus the full heat color on the icon and the words. */
export const FLAME_CHIP_CLASS: Record<StreakState, string> = {
  hot: "bg-flame-hot/12 text-flame-hot",
  warm: "bg-flame-warm/12 text-flame-warm",
  ember: "bg-flame-ember/12 text-flame-ember",
  dormant: "bg-flame-resting/12 text-flame-resting",
};

/**
 * Server heat states. Hot, Warm, and Ember use their tokens.
 * Quiet, cooled, and dormant use resting. This does not decide the state.
 */
export function flameClass(state: StreakState): string {
  return FLAME_CLASS[state];
}

/** Grade 2 is the lightest slate. Each higher grade is one step darker. Dark steps use white text. */
export function stepClass(grade: number): string {
  const index = Math.min(PALETTE.step.length, Math.max(1, grade - 1));
  const ink = index >= 4 ? "text-white" : "text-foreground";
  return `bg-step-${index} ${ink}`;
}
