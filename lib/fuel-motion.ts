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
