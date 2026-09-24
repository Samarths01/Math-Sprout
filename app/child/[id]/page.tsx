import { notFound, redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { ChildHomeFrame } from "@/components/child-home";
import { LogoutButton } from "@/components/logout-button";
import { Shell } from "@/components/shell";
import { readCompanion } from "@/lib/companion";
import { getDb } from "@/lib/db";
import { DomainError, getChildHome } from "@/lib/domain";
import { currentGuardian } from "@/lib/http";
import { readChildFocus } from "@/lib/home-presentation";

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
  const observedAt = new Date().toISOString();
  const companion = readCompanion(getDb(), home.child.id, observedAt);
  const focus = readChildFocus(getDb(), home.child.id);

  return (
    <Shell width="narrow">
      <AppHeader action={<LogoutButton />} />
      <main>
        <ChildHomeFrame
          childId={home.child.id}
          displayName={home.child.displayName}
          concept={focus.concept}
          bandLabel={focus.bandLabel}
          consentStatus={home.child.consentStatus}
          glance={companion.glance}
          started={companion.streak.lastQualifyingDay !== null}
          sourceEventId={companion.streak.sourceEventId}
          heat={companion.streak.state}
        />
      </main>
    </Shell>
  );
}
