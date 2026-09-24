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
  /**
   * Chip and badge words. Darker than the icon color so they clear 4.5:1
   * on a 12% white tint of that color. Icons keep the full color above.
   */
  flameText: {
    hot: "#AE4022",
    warm: "#A45610",
    ember: "#965214",
    resting: "#5F6368",
  },
  xp: "#E8B923",
  xpText: "#8A6500",
  piece: "#7C5CBF",
  pieceText: "#6E51AC",
  /** Steady and Stretch words, darker shades of the middle and last slate steps. */
  badgeText: {
    steady: "#5D687A",
    stretch: "#3E4654",
  },
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

/** 12% of `hex` mixed onto white. Chip and badge fills use this tint. */
export function tintOnWhite(hex: string): string {
  const raw = hex.replace("#", "");
  const channel = (index: number) =>
    Math.round(Number.parseInt(raw.slice(index, index + 2), 16) * 0.12 + 255 * 0.88);
  return `#${[0, 2, 4].map((index) => channel(index).toString(16).padStart(2, "0")).join("")}`;
}

/** Former forest-green primary. Buttons and progress must not use it. */
export const OLD_BRAND_GREEN = "oklch(0.42 0.09 155)";

export const FLAME_CLASS: Record<StreakState, string> = {
  hot: "text-flame-hot",
  warm: "text-flame-warm",
  ember: "text-flame-ember",
  dormant: "text-flame-resting",
};

/** Opaque 12% tint behind the flame chip. The icon keeps FLAME_CLASS. */
export const FLAME_TINT_CLASS: Record<StreakState, string> = {
  hot: "bg-flame-hot-tint",
  warm: "bg-flame-warm-tint",
  ember: "bg-flame-ember-tint",
  dormant: "bg-flame-resting-tint",
};

/** Darker flame words on the tint. */
export const FLAME_TEXT_CLASS: Record<StreakState, string> = {
  hot: "text-flame-hot-text",
  warm: "text-flame-warm-text",
  ember: "text-flame-ember-text",
  dormant: "text-flame-resting-text",
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
