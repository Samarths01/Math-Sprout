import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { ConsentControls } from "@/components/consent-controls";
import { LogoutButton } from "@/components/logout-button";
import { Shell } from "@/components/shell";
import { StatusPill } from "@/components/status-pill";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getDb } from "@/lib/db";
import { getParentHome } from "@/lib/domain";
import { currentGuardian } from "@/lib/http";
import { interfaceCopy } from "@/lib/interface-copy";
import { readOfflineCap } from "@/lib/offline-cap";
import { readPauseHold } from "@/lib/pause-hold";
import { ParentOneBreathCard } from "@/components/parent-one-breath";
import { readParentSummary } from "@/lib/parent-summary";
import { formatTimeZone } from "@/lib/timezones";
import { cn } from "@/lib/utils";
import { redirect } from "next/navigation";

export const metadata = { title: "Parent home" };

function PauseHoldNotice({
  guardianId,
  childId,
}: {
  guardianId: string;
  childId: string;
}) {
  const hold = readPauseHold(getDb(), guardianId, childId);
  if (!hold) return null;
  return (
    <p
      data-testid="pause-hold"
      data-visible="true"
      data-waiting={hold.waiting}
      className="text-sm leading-6"
    >
      {hold.waiting > 0 ? `${hold.waiting} waiting. ` : ""}
      {interfaceCopy(hold.copyKey)} {interfaceCopy(hold.detailKey)}
    </p>
  );
}

function OfflineCapNotice({
  guardianId,
  childId,
}: {
  guardianId: string;
  childId: string;
}) {
  const cap = readOfflineCap(getDb(), guardianId, childId);
  if (!cap) return null;
  return (
    <p
      data-testid="offline-cap-hold"
      data-visible="true"
      data-waiting={cap.waiting}
      className="text-sm leading-6"
    >
      {interfaceCopy(cap.copyKey)} {interfaceCopy(cap.detailKey)}
    </p>
  );
}

export default async function ParentHomePage() {
  const guardian = await currentGuardian();
  if (!guardian) redirect("/login");
  const home = getParentHome(getDb(), guardian.id);

  return (
    <Shell>
      <AppHeader eyebrow="Parent home" action={<LogoutButton />} />
      <main className="grid gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="grid gap-1">
            <h1 className="font-heading text-3xl tracking-tight">Your children</h1>
            <p className="text-sm text-muted-foreground">
              {home.guardian.timezone
                ? `Your timezone is ${formatTimeZone(home.guardian.timezone)}.`
                : "Your timezone is not set. New children default to America/Los Angeles unless you choose one."}
            </p>
          </div>
          <Link
            href="/parent/children/new"
            className={cn(buttonVariants({}), "h-11 px-4")}
          >
            Add a child
          </Link>
        </div>
        <Card>
          <CardContent className="text-sm leading-6 text-muted-foreground">
            {home.narrative}
          </CardContent>
        </Card>
        {home.children.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No child profiles yet</CardTitle>
              <CardDescription>
                Add one to set a timezone and manage consent. Practice stays
                blocked until you grant it.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <ul className="grid gap-3">
            {home.children.map((child) => (
              <li key={child.id}>
                <Card>
                  <CardHeader>
                    <CardTitle className="flex flex-wrap items-center gap-2 font-heading text-2xl">
                      {child.displayName}
                      <StatusPill status={child.consentStatus} />
                    </CardTitle>
                    <CardDescription>
                      Timezone {formatTimeZone(child.timezone)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4">
                    <p className="text-sm leading-6">
                      {child.practiceAllowed
                        ? "Practice is allowed. The child home can start a session."
                        : child.reason}
                    </p>
                    <ParentOneBreathCard
                      summary={readParentSummary(getDb(), guardian.id, child.id)}
                    />
                    <PauseHoldNotice guardianId={guardian.id} childId={child.id} />
                    <OfflineCapNotice guardianId={guardian.id} childId={child.id} />
                    <ConsentControls
                      childId={child.id}
                      status={child.consentStatus}
                    />
                    <Link
                      href={`/child/${child.id}`}
                      className={cn(
                        buttonVariants({ variant: "outline" }),
                        "h-10 w-full sm:w-fit",
                      )}
                    >
                      Open child home
                    </Link>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </main>
    </Shell>
  );
}
