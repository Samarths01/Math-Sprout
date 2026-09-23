import Link from "next/link";
import type { CompanionView } from "@/lib/companion";
import type { ProjectedPiece } from "@/lib/build-goal";
import { interfaceCopy } from "@/lib/interface-copy";
import type { StreakState } from "@/lib/streak";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

const TONE: Record<StreakState, string> = {
  hot: "text-orange-700",
  warm: "text-amber-700",
  ember: "text-orange-950",
  dormant: "text-muted-foreground",
};

function pieceLabel(piece: ProjectedPiece): string {
  const name = interfaceCopy(piece.copyKey);
  if (piece.role === "badge" && piece.skill) return `${name} · ${piece.skill}`;
  return name;
}

function CompanionFigure({
  state,
  placed,
  target,
}: {
  state: StreakState;
  placed: number;
  target: number;
}) {
  const grown = target > 0 ? Math.min(1, placed / target) : 0;
  const stemTop = 52 - grown * 14;
  const leaf = 8 + grown * 8;
  const showFlame = state !== "dormant";
  const flameHeight = state === "hot" ? 28 : state === "warm" ? 18 : 10;
  return (
    <svg
      viewBox="0 0 120 88"
      className={cn("h-24 w-full", TONE[state])}
      data-testid="companion-figure"
      data-fuel="heat"
      data-fuel-source="qualifying-event"
      data-streak-state={state}
      data-waning={state === "ember" ? "true" : "false"}
      data-growth={grown.toFixed(2)}
      aria-hidden="true"
    >
      <path d="M38 70h44c2 8-6 14-22 14S36 78 38 70Z" fill="currentColor" opacity="0.18" />
      <path
        d="M46 70c2 6 26 6 28 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.45"
      />
      <path
        d={`M60 70 V${stemTop}`}
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity={state === "dormant" ? 0.45 : 0.9}
      />
      {grown > 0 ? (
        <path
          d={`M60 ${stemTop + 8} C60 ${stemTop - 4}, ${60 + leaf} ${stemTop - 2}, ${60 + leaf} ${stemTop + 6} C${60 + leaf * 0.4} ${stemTop + 10}, 60 ${stemTop + 12}, 60 ${stemTop + 8} Z`}
          fill="currentColor"
          opacity={0.35 + grown * 0.5}
        />
      ) : null}
      {showFlame ? (
        <path
          d={`M86 ${64 - flameHeight} C90 ${58 - flameHeight}, 98 ${64 - flameHeight * 0.4}, 96 66 C100 62, 102 70, 94 74 C88 78, 80 70, 86 ${64 - flameHeight} Z`}
          fill="currentColor"
          opacity={state === "ember" ? 0.45 : 0.85}
        />
      ) : null}
    </svg>
  );
}

export function CompanionState({
  childId,
  practiceAllowed,
  companion,
  sproutGlance = false,
}: {
  childId: string;
  practiceAllowed: boolean;
  companion: CompanionView;
  /** True when accrued XP credits exist. A glance, not a count and not a link. */
  sproutGlance?: boolean;
}) {
  const { active, completed } = companion.build;
  const slots = active.complete
    ? active.pieces.length
    : Math.max(active.pieceTarget, active.pieces.length);
  const recovery = companion.streak.recovery;

  return (
    <Card
      data-testid="companion"
      data-streak-state={companion.streak.state}
      data-fuel-source="qualifying-event"
      data-heat-event-id={companion.streak.sourceEventId ?? ""}
      data-waning={companion.streak.state === "ember" ? "true" : "false"}
    >
      <CardHeader>
        <CardTitle id="companion-heading" className="font-heading text-2xl">
          The sprout
        </CardTitle>
        <CardDescription>The build and the flame follow practice.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <CompanionFigure
            state={companion.streak.state}
            placed={active.pieces.length}
            target={active.pieceTarget}
          />
          <p data-testid="streak-copy" data-copy-key={companion.streak.copyKey}>
            {interfaceCopy(companion.streak.copyKey)}
          </p>
          {sproutGlance ? (
            <p
              data-testid="sprout-glance"
              data-fuel="xp"
              data-fuel-source="qualifying-event"
              data-copy-key="fuel.home.sprout"
              className="text-sm leading-6 text-muted-foreground"
            >
              {interfaceCopy("fuel.home.sprout")}
            </p>
          ) : null}
          {recovery ? (
            <div className="grid gap-2" data-testid="ember-recovery">
              <p className="text-sm leading-6 text-muted-foreground" data-copy-key={recovery.detailKey}>
                {interfaceCopy(recovery.detailKey)}
              </p>
              {practiceAllowed ? (
                <Link
                  href={`/child/${childId}/practice`}
                  data-testid="ember-recovery-action"
                  className={cn(buttonVariants(), "h-12 w-full text-base")}
                >
                  {interfaceCopy(recovery.copyKey)}
                </Link>
              ) : (
                <button
                  type="button"
                  disabled
                  data-testid="ember-recovery-action"
                  data-recovery-blocked="true"
                  className={cn(buttonVariants(), "h-12 w-full text-base")}
                >
                  {interfaceCopy(recovery.copyKey)}
                </button>
              )}
            </div>
          ) : null}
        </div>
        <div
          className="grid gap-2"
          data-testid="build-goal"
          data-fuel="pieces"
          data-fuel-source="qualifying-event"
          data-goal-id={active.id}
          data-goal-active="true"
          data-piece-count={active.pieces.length}
          data-piece-target={active.pieceTarget}
          data-goal-complete={active.complete ? "true" : "false"}
        >
          <h3 className="font-heading text-xl">{active.title}</h3>
          {active.pieces.length === 0 ? (
            <p className="text-sm leading-6 text-muted-foreground" data-copy-key="build.empty">
              {interfaceCopy("build.empty")}
            </p>
          ) : null}
          {active.complete ? (
            <p className="text-sm leading-6" data-copy-key="build.complete">
              {interfaceCopy("build.complete")}
            </p>
          ) : null}
          <ol className="grid gap-2">
            {Array.from({ length: slots }, (_, index) => {
              const piece = active.pieces[index];
              return (
                <li
                  key={piece?.eventId ?? `open-${index}`}
                  data-testid="build-slot"
                  data-piece-role={piece?.role ?? "open"}
                  data-event-id={piece?.eventId ?? ""}
                  className={
                    piece
                      ? "rounded-lg bg-secondary px-3 py-2 text-sm"
                      : "rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
                  }
                >
                  {piece ? pieceLabel(piece) : "Still open"}
                </li>
              );
            })}
          </ol>
        </div>
        {completed.length > 0 ? (
          <ul className="grid gap-1">
            {completed.map((goal) => (
              <li
                key={goal.id}
                data-testid="build-goal-complete"
                data-goal-id={goal.id}
                className="text-sm text-muted-foreground"
              >
                {goal.title}. {interfaceCopy("build.complete")}
              </li>
            ))}
          </ul>
        ) : null}
        <Link
          href={`/child/${childId}/badges`}
          data-testid="badge-link"
          data-badge-count={companion.badges.length}
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          {interfaceCopy("badge.heading")}
          {companion.badges.length > 0 ? ` · ${companion.badges.length}` : ""}
        </Link>
      </CardContent>
    </Card>
  );
}
