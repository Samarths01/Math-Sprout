import Link from "next/link";
import { FuelStrip } from "@/components/fuel-strip";
import { PracticeCta } from "@/components/practice-cta";
import { Card, CardContent } from "@/components/ui/card";
import type { CompanionGlance } from "@/lib/companion";
import { fuelStripText, childBlockCopyKey } from "@/lib/home-presentation";
import { interfaceCopy } from "@/lib/interface-copy";
import type { ConsentViewStatus } from "@/lib/practice-gate";
import type { BandLabel } from "@/lib/attempt-contract";

/**
 * Child home frame. Greeting, focus, band, one practice control, fuel strip, badges link.
 */
export function ChildHomeFrame({
  childId,
  displayName,
  concept,
  bandLabel,
  consentStatus,
  glance,
  started,
  sourceEventId,
}: {
  childId: string;
  displayName: string;
  concept: string;
  bandLabel: BandLabel;
  consentStatus: ConsentViewStatus;
  glance: CompanionGlance;
  started: boolean;
  sourceEventId: string | null;
}) {
  const text = fuelStripText({
    started,
    dayCount: glance.dayCount,
    xp: glance.xp,
    pieces: glance.pieces,
    goal: glance.goal,
  });
  const flame = !started ? "start" : glance.dayCount === null ? "resting" : "lit";
  const blockKey = childBlockCopyKey(consentStatus);

  return (
    <div className="grid gap-4" data-testid="child-home">
      <Card>
        <CardContent className="grid gap-3">
          <p data-testid="child-greeting" className="text-base">
            Hi, {displayName}
          </p>
          <div className="grid gap-1">
            <p
              data-testid="focus-label"
              data-copy-key="home.focus.kicker"
              className="text-xs font-medium tracking-[0.14em] text-muted-foreground"
            >
              {interfaceCopy("home.focus.kicker")}
            </p>
            <h1
              data-testid="focus-concept"
              className="font-heading text-3xl tracking-tight"
            >
              {concept}
            </h1>
            <p data-testid="focus-band" className="text-sm text-muted-foreground">
              {bandLabel}
            </p>
          </div>
          <PracticeCta childId={childId} blockKey={blockKey} />
          <FuelStrip
            childId={childId}
            text={text}
            xp={glance.xp}
            dayCount={glance.dayCount}
            pieces={glance.pieces}
            goal={glance.goal}
            flame={flame}
            sourceEventId={sourceEventId}
          />
        </CardContent>
      </Card>
      <Link
        href={`/child/${childId}/badges`}
        data-testid="badge-link"
        className="w-fit text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        {interfaceCopy("home.badges.link")}
      </Link>
    </div>
  );
}
