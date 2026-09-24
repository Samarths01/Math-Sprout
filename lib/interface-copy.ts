/**
 * Interface copy for companion surfaces. Screens look up these keys.
 * The strings stay free of scores, percents, and confidence.
 */
export const INTERFACE_COPY = {
  "streak.hot": "The flame is hot. A qualifying day followed the one before it.",
  "streak.warm": "The flame is warm. A qualifying day started it.",
  "streak.ember": "The flame is an ember. A careful try can warm it.",
  "streak.dormant": "The flame is quiet. A careful practice day starts it warm again.",
  "streak.ember.recover": "Practice today to warm the flame",
  "streak.ember.recover.detail": "There is no rush. A careful try today is enough.",
  "build.empty": "Open spots fill from a badge, a slightly harder step, or a hot streak.",
  "build.complete": "This build is full.",
  "badge.empty": "Badges show up here when a skill reaches Got it.",
  "badge.earned": "Got it",
  "badge.heading": "Badges",
  "piece.badge": "Badge",
  "piece.level": "A little harder",
  "piece.build": "Build piece",
  "piece.streak": "Streak",
  "fuel.xp.full": "A sprout for that try.",
  "fuel.xp.quiet": "A quiet sprout. This one stays small.",
  "fuel.xp.none": "No sprout this time.",
  "fuel.piece": "A piece of the build is in place.",
  "fuel.home.sprout": "A sprout grew from a careful try.",
  "fuel.glance.heat.hot": "Hot",
  "fuel.glance.heat.warm": "Warm",
  "fuel.glance.heat.ember": "Ember",
  "fuel.glance.heat.dormant": "Quiet",
  "fuel.glance.xp.empty": "No sprout yet",
  "fuel.glance.piece.empty": "Open spots",
  "fuel.glance.label.heat": "Flame",
  "fuel.glance.label.xp": "Sprout",
  "fuel.glance.label.piece": "Piece",
  "pause.hold.waiting": "Answers are waiting while practice is paused.",
  "pause.hold.resuming": "Answers are still waiting to save.",
  "pause.hold.waiting.detail":
    "Granting practice saves them quietly. There is no celebration for those tries.",
  "pause.hold.empty":
    "Practice is paused. Answers that check in wait here until you grant practice again.",
  "pause.hold.kid":
    "This try is waiting. A parent can see it. It saves quietly when practice is allowed again.",
  "pause.resume.quiet": "Saved. The tries that waited did not get a celebration.",
  "offline.cap.kid": "These answers are waiting to sync. Stay with this problem.",
  "offline.cap.waiting": "The offline limit is full. Answers are waiting to sync.",
  "offline.cap.detail": "They stay on this focus until the practice record catches up.",
  "parent.breath.empty": "No practice yet.",
  "parent.breath.emptyToday": "No practice yet today.",
  "parent.breath.noBand": "No band movement yet",
} as const;

export type InterfaceCopyKey = keyof typeof INTERFACE_COPY;

export function interfaceCopy(key: InterfaceCopyKey): string {
  return INTERFACE_COPY[key];
}
