"use client";

import { useEffect, useRef } from "react";
import { consumeFuelPulse, releaseFuelPulse } from "@/lib/fuel-motion";
import { fuelStripText } from "@/lib/home-presentation";
import { flameClass } from "@/lib/palette";
import type { StreakState } from "@/lib/streak";
import { cn } from "@/lib/utils";

/**
 * Numeric fuel line under the practice control.
 * Not a link. Pulses once when practice just stored a mint-toast flag.
 */
export function FuelStrip({
  childId,
  text,
  xp,
  dayCount,
  pieces,
  goal,
  flame,
  heat,
  sourceEventId,
  forcePulse = false,
}: {
  childId: string;
  text?: string;
  xp: number;
  dayCount: number | null;
  pieces: number;
  goal: number;
  flame: "start" | "resting" | "lit";
  /** Server heat state. Quiet, cooled, and dormant render as resting. */
  heat?: StreakState;
  sourceEventId: string | null;
  forcePulse?: boolean;
}) {
  const stripRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (forcePulse) return;
    const node = stripRef.current;
    if (!node || !consumeFuelPulse(window.sessionStorage, childId)) return;
    node.dataset.pulse = "once";
    node.classList.add("fuel-strip-pulse");
    const timer = window.setTimeout(() => releaseFuelPulse(childId), 1000);
    return () => window.clearTimeout(timer);
  }, [childId, forcePulse]);

  const started = flame !== "start";
  const line =
    text ??
    fuelStripText({
      started,
      dayCount,
      xp,
      pieces,
      goal,
    });
  const [flamePart, xpPart, piecePart] = line.split(" · ");
  const heatState: StreakState = heat ?? (flame === "lit" ? "hot" : "dormant");

  return (
    <p
      data-testid="fuel-strip"
      data-fuel-source="qualifying-event"
      data-fuel="heat xp pieces"
      data-xp={xp}
      data-day-count={dayCount ?? ""}
      data-pieces={pieces}
      data-goal={goal}
      data-flame={flame}
      data-heat={heatState}
      data-heat-event-id={sourceEventId ?? ""}
      ref={stripRef}
      data-pulse={forcePulse ? "once" : "false"}
      className={cn(
        "flex h-11 items-center overflow-hidden rounded-lg bg-muted px-3 font-sans text-sm font-medium tracking-tight whitespace-nowrap",
        forcePulse && "fuel-strip-pulse",
      )}
    >
      <span data-testid="fuel-flame" className={flameClass(heatState)}>
        {flamePart}
      </span>
      <span className="text-muted-foreground"> · </span>
      <span data-testid="fuel-xp-count" className="text-xp">
        {xpPart}
      </span>
      <span className="text-muted-foreground"> · </span>
      <span data-testid="fuel-pieces-count" className="text-piece">
        {piecePart}
      </span>
    </p>
  );
}
