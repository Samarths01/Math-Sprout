"use client";

import { useEffect, useRef } from "react";
import { consumeFuelPulse, releaseFuelPulse } from "@/lib/fuel-motion";
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
  sourceEventId,
  forcePulse = false,
}: {
  childId: string;
  text: string;
  xp: number;
  dayCount: number | null;
  pieces: number;
  goal: number;
  flame: "start" | "resting" | "lit";
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
      data-heat-event-id={sourceEventId ?? ""}
      ref={stripRef}
      data-pulse={forcePulse ? "once" : "false"}
      className={cn(
        "flex h-11 items-center overflow-hidden rounded-lg bg-secondary/70 px-3 font-sans text-sm font-medium tracking-tight text-secondary-foreground whitespace-nowrap",
        forcePulse && "fuel-strip-pulse",
      )}
    >
      {text}
    </p>
  );
}
