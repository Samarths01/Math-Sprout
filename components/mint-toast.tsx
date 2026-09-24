import type { CelebrationTier } from "@/lib/attempt-contract";
import { mintToast } from "@/lib/fuel-motion";
import { interfaceCopy, type InterfaceCopyKey } from "@/lib/interface-copy";

const XP_COPY: Record<"full" | "quietXp" | "none", InterfaceCopyKey> = {
  full: "fuel.xp.full",
  quietXp: "fuel.xp.quiet",
  none: "fuel.xp.none",
};

/**
 * Quiet mint moment inside practice. Not a destination.
 * One sprout line, and at most one piece beat when the tier is full.
 */
export function MintToast({
  tier,
  credit,
  eventCount,
  pieceEventIds,
  replayed,
}: {
  tier: CelebrationTier;
  credit: number;
  eventCount: number;
  pieceEventIds: readonly string[];
  replayed: boolean;
}) {
  const plan = mintToast({ tier, credit, eventCount, pieceEventIds, replayed });
  const xpKey = XP_COPY[plan.xp];
  return (
    <div data-testid="mint-toast" data-fuel-source="qualifying-event" className="grid gap-1">
      <p
        data-testid="fuel-xp"
        data-fuel="xp"
        data-xp-backed={plan.xp === "none" ? "false" : "true"}
        data-celebration-tier={plan.xp}
        data-copy-key={xpKey}
        role="status"
        className={
          plan.xp === "full"
            ? "text-sm font-medium leading-6 text-primary"
            : plan.xp === "quietXp"
              ? "text-sm font-medium leading-6 text-foreground"
              : "text-sm leading-6 text-muted-foreground"
        }
      >
        {interfaceCopy(xpKey)}
        {replayed ? " This try was already saved." : ""}
      </p>
      {plan.pieceEventId ? (
        <p
          data-testid="fuel-piece"
          data-fuel="pieces"
          data-piece-id={plan.pieceEventId}
          data-copy-key="fuel.piece"
          role="status"
          className="text-sm leading-6"
        >
          {interfaceCopy("fuel.piece")}
        </p>
      ) : null}
    </div>
  );
}
