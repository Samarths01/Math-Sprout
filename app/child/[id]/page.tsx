import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { CompanionState } from "@/components/companion-state";
import { FuelStrip } from "@/components/fuel-strip";
import { LogoutButton } from "@/components/logout-button";
import { PracticeCta } from "@/components/practice-cta";
import { Shell } from "@/components/shell";
import { StatusPill } from "@/components/status-pill";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { readCompanion } from "@/lib/companion";
import { accruedXp } from "@/lib/fuel";
import { getDb } from "@/lib/db";
import { DomainError, getChildHome } from "@/lib/domain";
import { currentGuardian } from "@/lib/http";
import { formatTimeZone } from "@/lib/timezones";

export const metadata = { title: "Child home" };

export default async function ChildHomePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const guardian = await currentGuardian();
  if (!guardian) redirect("/login");
  const { id } = await params;

  let home;
  try {
    home = getChildHome(getDb(), guardian.id, id);
  } catch (error) {
    if (error instanceof DomainError && error.status === 404) notFound();
    throw error;
  }
  const companion = readCompanion(getDb(), home.child.id, new Date().toISOString());
  const sproutGlance = accruedXp(getDb(), home.child.id) > 0;
  const placedPieces = [
    ...companion.build.completed.flatMap((goal) => goal.pieces),
    ...companion.build.active.pieces,
  ];

  return (
    <Shell width="narrow">
      <AppHeader eyebrow="Child home" action={<LogoutButton />} />
      <main className="grid gap-4">
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">Hi,</p>
          <h1 className="font-heading text-4xl tracking-tight">
            {home.child.displayName}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={home.child.consentStatus} />
            <p className="text-sm text-muted-foreground">
              Clock set to {formatTimeZone(home.child.timezone)}
            </p>
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="font-heading text-2xl">Practice</CardTitle>
            <CardDescription>
              Only a parent can allow practice. Missing, paused, or revoked
              consent does not start a session.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PracticeCta
              childId={home.child.id}
              practiceAllowed={home.practiceAllowed}
              reason={home.reason}
              fuel={
                <FuelStrip
                  streak={companion.streak}
                  sprout={sproutGlance}
                  piece={placedPieces.at(-1) ?? null}
                />
              }
            />
          </CardContent>
        </Card>
        <CompanionState
          childId={home.child.id}
          practiceAllowed={home.practiceAllowed}
          companion={companion}
        />
        <Link
          href="/parent"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          Back to parent home
        </Link>
      </main>
    </Shell>
  );
}
