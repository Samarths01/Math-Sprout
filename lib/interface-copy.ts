/**
 * Interface copy for companion surfaces. Screens look up these keys.
 * The strings stay free of scores, percents, and confidence.
 */
export const INTERFACE_COPY = {
  "streak.hot": "The flame is hot. A qualifying day followed the one before it.",
  "streak.warm": "The flame is warm. A qualifying day started it.",
  "streak.ember": "The flame is an ember. It cools when today ends.",
  "streak.dormant": "The flame is quiet. A careful practice day starts it warm again.",
  "streak.ember.recover": "Practice today to bring the flame back",
  "streak.ember.recover.detail":
    "A careful try before the ember goes out keeps this streak alive.",
  "build.empty": "Open spots fill from a badge, a slightly harder step, or a hot streak.",
  "build.complete": "This build is full.",
  "badge.empty": "Badges show up here when a skill reaches Got it.",
  "badge.earned": "Got it",
  "badge.heading": "Badges",
  "piece.badge": "Badge",
  "piece.level": "A little harder",
  "piece.build": "Build piece",
  "piece.streak": "Streak",
} as const;

export type InterfaceCopyKey = keyof typeof INTERFACE_COPY;

export function interfaceCopy(key: InterfaceCopyKey): string {
  return INTERFACE_COPY[key];
}
