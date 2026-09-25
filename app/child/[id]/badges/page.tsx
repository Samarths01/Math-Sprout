import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { LogoutButton } from "@/components/logout-button";
import { Shell } from "@/components/shell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BuildGoalPanel } from "@/components/build-goal-panel";
import { readCompanion } from "@/lib/companion";
import { getDb } from "@/lib/db";
import { DomainError, getChildHome } from "@/lib/domain";
import { currentGuardian } from "@/lib/http";
import { interfaceCopy } from "@/lib/interface-copy";

export const metadata = { title: "Badges" };

function formatLocalDay(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  if (!year || !month || !day) return ymd;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export default async function BadgeScreenPage({
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
  const badges = companion.badges;

  return (
    <Shell width="narrow">
      <AppHeader eyebrow="Badges" action={<LogoutButton />} />
      <main className="grid gap-4">
        <div className="grid gap-1">
          <h1 className="font-heading text-4xl tracking-tight">
            {interfaceCopy("badge.heading")}
          </h1>
          <p className="text-sm text-muted-foreground">{home.child.displayName}</p>
        </div>
        <Card>
          <CardContent>
            <BuildGoalPanel build={companion.build} />
          </CardContent>
        </Card>
        {badges.length === 0 ? (
          <Card data-testid="badge-empty">
            <CardHeader>
              <CardTitle className="font-heading text-2xl">No badges yet</CardTitle>
              <CardDescription data-copy-key="badge.empty">
                {interfaceCopy("badge.empty")}
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <ul className="grid gap-3">
            {badges.map((badge) => (
              <li key={badge.eventId}>
                <Card data-testid="badge" data-skill={badge.skill} data-event-id={badge.eventId}>
                  <CardHeader>
                    <CardTitle className="font-heading text-2xl">{badge.skill}</CardTitle>
                    <CardDescription data-copy-key="badge.earned">
                      {interfaceCopy("badge.earned")}
                      {badge.localDay ? ` · ${formatLocalDay(badge.localDay)}` : ""}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">
                    {badge.band}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
        <Link
          href={`/child/${home.child.id}`}
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          Back to child home
        </Link>
      </main>
    </Shell>
  );
}
