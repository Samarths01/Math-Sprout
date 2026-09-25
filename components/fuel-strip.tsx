"use client";

import { useEffect, useRef } from "react";
import { FlameMark, PieceMark, StarMark } from "@/components/fuel-mark";
import { consumeFuelPulse, releaseFuelPulse } from "@/lib/fuel-motion";
import type { FuelStripView } from "@/lib/fuel-strip-view";
import { FLAME_CLASS, FLAME_TEXT_CLASS, FLAME_TINT_CLASS } from "@/lib/palette";
import { cn } from "@/lib/utils";

/**
 * Three fuel chips under the practice control.
 * Not a link. Pulses once when practice just stored a mint-toast flag.
 * Icons are drawn. The words stay the data-driven strip sentence.
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
}: FuelStripView) {
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

  const [flamePart, xpPart, piecePart] = text.split(" · ");
  const heatState = heat ?? (flame === "lit" ? "hot" : "dormant");

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
        "flex h-11 items-center gap-1.5 overflow-hidden rounded-[12px] bg-muted px-1.5 font-sans text-[13px] font-semibold tracking-tight whitespace-nowrap",
        forcePulse && "fuel-strip-pulse",
      )}
    >
      <span
        data-testid="fuel-flame"
        className={cn(
          "inline-flex h-7 min-w-0 items-center gap-1 rounded-full px-2 tabular-nums",
          FLAME_TINT_CLASS[heatState],
        )}
      >
        <span className={FLAME_CLASS[heatState]}>
          <FlameMark />
        </span>
        <span className={FLAME_TEXT_CLASS[heatState]}>{chipLabel(flamePart)}</span>
      </span>
      <span className="sr-only"> · </span>
      <span
        data-testid="fuel-xp-count"
        className="inline-flex h-7 min-w-0 items-center gap-1 rounded-full bg-xp-tint px-2 tabular-nums"
      >
        <span className="text-xp">
          <StarMark />
        </span>
        <span className="text-xp-text">{xpChipLabel(xpPart)}</span>
      </span>
      <span className="sr-only"> · </span>
      <span
        data-testid="fuel-pieces-count"
        className="inline-flex h-7 min-w-0 items-center gap-1 rounded-full bg-piece-tint px-2 tabular-nums"
      >
        <span className="text-piece">
          <PieceMark />
        </span>
        <span className="text-piece-text">{chipLabel(piecePart)}</span>
      </span>
    </p>
  );
}

function chipLabel(part: string | undefined): string {
  return (part ?? "").replace(/^[🔥⭐🧩]\s*/u, "").trim();
}

/** The XP chip always shows the unit, including when a fixture passes a bare number. */
function xpChipLabel(part: string | undefined): string {
  const label = chipLabel(part);
  if (/\bXP\b/i.test(label)) return label;
  return label ? `${label} XP` : "XP";
}
