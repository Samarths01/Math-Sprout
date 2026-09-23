import type { CelebrationTier } from "@/lib/attempt-contract";
import { xpBacked, type FuelMotionKind } from "@/lib/fuel-motion";
import { interfaceCopy, type InterfaceCopyKey } from "@/lib/interface-copy";
import type { StreakState } from "@/lib/streak";

const XP_COPY: Record<CelebrationTier, InterfaceCopyKey> = {
  full: "fuel.xp.full",
  quietXp: "fuel.xp.quiet",
  none: "fuel.xp.none",
};

/**
 * Kid-visible fuel for one practice moment.
 * Heat and pieces come from the companion projection. XP copy appears only
 * when this try's credit is backed by qualifying events.
 */
export function FuelMoment({
  heat,
  pieceEventIds,
  pieceMotion,
  xp,
}: {
  heat: {
    streakState: StreakState;
    copyKey: InterfaceCopyKey;
    sourceEventId: string | null;
    motion: FuelMotionKind;
  } | null;
  pieceEventIds: readonly string[];
  pieceMotion: FuelMotionKind;
  xp: {
    credit: number;
    eventCount: number;
    tier: CelebrationTier;
    replayed: boolean;
  } | null;
}) {
  const backed = xp ? xpBacked(xp) : false;
  const xpTier: CelebrationTier = backed && xp ? xp.tier : "none";
  const xpKey = XP_COPY[xpTier];
  const animateXp = Boolean(backed && xp && !xp.replayed);
  const animateHeat = Boolean(heat && heat.motion === "mint" && heat.sourceEventId);
  const animatePieces = pieceMotion === "mint" && pieceEventIds.length > 0;

  return (
    <section
      data-testid="fuel-moment"
      data-fuel-source="qualifying-event"
      aria-live="polite"
      className="grid gap-2 rounded-lg bg-secondary/60 px-3 py-3"
    >
      {heat ? (
        <p
          data-testid="fuel-heat"
          data-fuel="heat"
          data-streak-state={heat.streakState}
          data-heat-event-id={heat.sourceEventId ?? ""}
          data-waning={heat.streakState === "ember" ? "true" : "false"}
          data-heat-motion={heat.motion}
          data-animated={animateHeat ? "true" : "false"}
          data-copy-key={heat.copyKey}
          className={animateHeat ? "text-sm leading-6 motion-safe:animate-pulse" : "text-sm leading-6"}
        >
          {interfaceCopy(heat.copyKey)}
        </p>
      ) : null}
      {animatePieces ? (
        <p
          data-testid="fuel-piece"
          data-fuel="pieces"
          data-piece-motion={pieceMotion}
          data-piece-ids={pieceEventIds.join(",")}
          data-animated="true"
          data-copy-key="fuel.piece"
          className="text-sm leading-6 motion-safe:animate-pulse"
        >
          {interfaceCopy("fuel.piece")}
        </p>
      ) : (
        <p
          data-testid="fuel-piece"
          data-fuel="pieces"
          data-piece-motion={pieceMotion}
          data-piece-ids={pieceEventIds.join(",")}
          data-animated="false"
          className="sr-only"
        >
          {pieceEventIds.length > 0 ? interfaceCopy("fuel.piece") : interfaceCopy("build.empty")}
        </p>
      )}
      {xp ? (
        <p
          data-testid="fuel-xp"
          data-fuel="xp"
          data-xp-backed={backed ? "true" : "false"}
          data-celebration-tier={xpTier}
          data-animated={animateXp ? "true" : "false"}
          data-copy-key={xpKey}
          className={
            animateXp
              ? "text-sm leading-6 text-muted-foreground motion-safe:animate-pulse"
              : "text-sm leading-6 text-muted-foreground"
          }
        >
          {interfaceCopy(xpKey)}
          {xp.replayed ? " This try was already saved." : ""}
        </p>
      ) : null}
    </section>
  );
}
