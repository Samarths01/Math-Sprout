import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { LogoutButton } from "@/components/logout-button";
import { PracticeSession } from "@/components/practice-session";
import { Shell } from "@/components/shell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getDb } from "@/lib/db";
import { DomainError, getChildHome } from "@/lib/domain";
import { currentGuardian } from "@/lib/http";

export const dynamic = "force-dynamic";
export const metadata = { title: "Practice" };

export default async function PracticePage({
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

  return (
    <Shell width="narrow">
      <AppHeader eyebrow="Practice" action={<LogoutButton />} />
      <main className="grid gap-4">
        {home.practiceAllowed ? (
          <PracticeSession
            childId={home.child.id}
            displayName={home.child.displayName}
          />
        ) : (
          <Card data-testid="practice-blocked">
            <CardHeader>
              <CardTitle className="font-heading text-2xl">
                Practice is closed
              </CardTitle>
              <CardDescription>
                A session starts only when consent is granted.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <p className="text-sm leading-6">{home.reason}</p>
              <Link
                href={`/child/${home.child.id}`}
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                Back to child home
              </Link>
            </CardContent>
          </Card>
        )}
      </main>
    </Shell>
  );
}
