export type ConsentAction = "grant" | "pause" | "revoke";
export type StoredConsentStatus = "granted" | "paused" | "revoked";
export type ConsentViewStatus = StoredConsentStatus | "none";

export function statusForAction(action: ConsentAction): StoredConsentStatus {
  switch (action) {
    case "grant":
      return "granted";
    case "pause":
      return "paused";
    case "revoke":
      return "revoked";
  }
}

export const PRACTICE_BLOCK_REASONS = {
  none: "Practice is blocked until a parent grants consent.",
  paused:
    "Practice is paused. A parent can grant consent again from the parent home.",
  revoked: "Practice is blocked because a parent revoked consent.",
} as const;

/**
 * Device-queue disposition when practice is not allowed.
 * Revoke, pause, and missing consent drop the pending queue. Nothing syncs.
 * Pause-hold is not locked: a hold that celebrates on resume is not shipped.
 * Granted consent has no disposition because a live try may sync.
 */
export function queueDisposition(
  status: ConsentViewStatus,
): "hold" | "drop" | null {
  if (status === "granted") return null;
  return "drop";
}

export function practiceGate(status: ConsentViewStatus): {
  practiceAllowed: boolean;
  reason?: string;
} {
  if (status === "granted") {
    return { practiceAllowed: true };
  }
  return {
    practiceAllowed: false,
    reason: PRACTICE_BLOCK_REASONS[status],
  };
}

/**
 * Click outcome for the practice control.
 * Granted consent can start a practice session. Every other status stays blocked.
 */
export function practiceClickOutcome(
  practiceAllowed: boolean,
): "blocked" | "start-session" {
  if (!practiceAllowed) return "blocked";
  return "start-session";
}
