import type { CelebrationTier } from "@/lib/attempt-contract";

/**
 * One mint moment for the practice try that just saved.
 * The tier has to be backed by a QualifyingEvent credit in the same response.
 * Review (quietXp) is a reduced toast only. A full try may add one piece beat.
 * A replay does not play the piece beat again.
 */
export type MintToastPlan = {
  xp: "full" | "quietXp" | "none";
  pieceEventId: string | null;
};

export function xpBacked(input: {
  credit: number;
  eventCount: number;
  tier: CelebrationTier;
}): boolean {
  return (
    input.credit > 0 &&
    input.eventCount > 0 &&
    (input.tier === "full" || input.tier === "quietXp")
  );
}

export function mintToast(input: {
  tier: CelebrationTier;
  credit: number;
  eventCount: number;
  pieceEventIds: readonly string[];
  replayed: boolean;
}): MintToastPlan {
  if (!xpBacked(input)) return { xp: "none", pieceEventId: null };
  if (input.tier !== "full") return { xp: "quietXp", pieceEventId: null };
  const pieceEventId =
    !input.replayed && input.pieceEventIds.length > 0 ? input.pieceEventIds[0] : null;
  return { xp: "full", pieceEventId };
}

const FUEL_PULSE_PREFIX = "math-sprout:fuel-pulse:";

export function fuelPulseStorageKey(childId: string): string {
  return `${FUEL_PULSE_PREFIX}${childId}`;
}

/**
 * The home strip pulses once on the return that follows a mint toast.
 * A replay and a quiet resume do not pulse. The toast rules stay in `xpBacked`.
 */
export function shouldPulseFuelStrip(input: {
  tier: CelebrationTier;
  credit: number;
  eventCount: number;
  replayed: boolean;
  resumeQuiet: boolean;
}): boolean {
  if (input.replayed || input.resumeQuiet) return false;
  return xpBacked(input);
}

export function markFuelPulse(
  storage: { setItem(key: string, value: string): void },
  childId: string,
  input: {
    tier: CelebrationTier;
    credit: number;
    eventCount: number;
    replayed: boolean;
    resumeQuiet: boolean;
    eventId: string | null;
  },
): boolean {
  if (!shouldPulseFuelStrip(input)) return false;
  storage.setItem(fuelPulseStorageKey(childId), input.eventId ?? "mint");
  return true;
}

/**
 * Survives a development remount: the storage flag is cleared on the first
 * read, and the child id stays marked until `releaseFuelPulse`.
 */
const heldFuelPulse = new Map<string, string>();

export function consumeFuelPulse(
  storage: { getItem(key: string): string | null; removeItem(key: string): void },
  childId: string,
): boolean {
  const key = fuelPulseStorageKey(childId);
  const token = storage.getItem(key);
  if (token) {
    heldFuelPulse.set(childId, token);
    storage.removeItem(key);
  }
  return heldFuelPulse.has(childId);
}

export function releaseFuelPulse(childId: string): void {
  heldFuelPulse.delete(childId);
}
