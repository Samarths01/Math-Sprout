import type { ReactNode } from "react";
import type { ProjectedPiece } from "@/lib/build-goal";
import type { StreakSurface } from "@/lib/companion";
import { interfaceCopy, type InterfaceCopyKey } from "@/lib/interface-copy";
import type { StreakState } from "@/lib/streak";
import { Flame, Leaf, Puzzle } from "lucide-react";

const HEAT_KEY: Record<StreakState, InterfaceCopyKey> = {
  hot: "fuel.glance.heat.hot",
  warm: "fuel.glance.heat.warm",
  ember: "fuel.glance.heat.ember",
  dormant: "fuel.glance.heat.dormant",
};

function GlanceCell({
  testId,
  fuel,
  backed,
  labelKey,
  copyKey,
  value,
  icon,
  eventId,
}: {
  testId: string;
  fuel: "heat" | "xp" | "pieces";
  backed: boolean;
  labelKey: InterfaceCopyKey;
  copyKey: InterfaceCopyKey;
  value: string;
  icon: ReactNode;
  eventId?: string;
}) {
  return (
    <div
      data-testid={testId}
      data-fuel={fuel}
      data-fuel-source="qualifying-event"
      data-backed={backed ? "true" : "false"}
      data-copy-key={copyKey}
      data-event-id={eventId ?? ""}
      className={
        backed
          ? "grid justify-items-center gap-1 rounded-lg bg-secondary px-2 py-2 text-center text-secondary-foreground"
          : "grid justify-items-center gap-1 rounded-lg bg-muted px-2 py-2 text-center text-muted-foreground"
      }
    >
      {icon}
      <span className="text-[0.7rem] font-medium tracking-wide">
        {interfaceCopy(labelKey)}
      </span>
      <span className="font-sans text-sm font-bold leading-snug">{value}</span>
    </div>
  );
}

/**
 * Flame, sprout, and piece under the Practice button.
 * Each cell is a qualifying-event projection. This strip is not a link.
 */
export function FuelStrip({
  streak,
  sprout,
  piece,
}: {
  streak: StreakSurface;
  sprout: boolean;
  piece: ProjectedPiece | null;
}) {
  const heatKey = HEAT_KEY[streak.state];
  const xpKey: InterfaceCopyKey = sprout ? "fuel.home.sprout" : "fuel.glance.xp.empty";
  const pieceKey: InterfaceCopyKey = piece?.copyKey ?? "fuel.glance.piece.empty";
  return (
    <div
      data-testid="fuel-strip"
      data-fuel-source="qualifying-event"
      role="group"
      aria-label="Practice fuel"
      className="grid grid-cols-3 gap-2"
    >
      <GlanceCell
        testId="fuel-glance-heat"
        fuel="heat"
        backed={streak.state !== "dormant"}
        labelKey="fuel.glance.label.heat"
        copyKey={heatKey}
        value={interfaceCopy(heatKey)}
        icon={<Flame className="size-5" aria-hidden="true" />}
        eventId={streak.sourceEventId ?? undefined}
      />
      <GlanceCell
        testId="sprout-glance"
        fuel="xp"
        backed={sprout}
        labelKey="fuel.glance.label.xp"
        copyKey={xpKey}
        value={interfaceCopy(xpKey)}
        icon={<Leaf className="size-5" aria-hidden="true" />}
      />
      <GlanceCell
        testId="fuel-glance-piece"
        fuel="pieces"
        backed={piece !== null}
        labelKey="fuel.glance.label.piece"
        copyKey={pieceKey}
        value={interfaceCopy(pieceKey)}
        icon={<Puzzle className="size-5" aria-hidden="true" />}
        eventId={piece?.eventId}
      />
    </div>
  );
}
