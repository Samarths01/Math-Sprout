import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { Shell } from "@/components/shell";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { currentGuardian } from "@/lib/http";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (await currentGuardian()) redirect("/parent");

  return (
    <Shell>
      <AppHeader eyebrow="Grades 2–4 · Parent-managed" />
      <main className="grid gap-6">
        <div className="grid gap-3">
          <h1 className="font-heading text-4xl leading-tight tracking-tight text-balance sm:text-5xl">
            Math practice, with a parent in charge.
          </h1>
          <p className="max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
            Math Sprout is a place for grades 2–4 to practice number sense.
            This version is the front door: a parent account, a child profile,
            and a clear yes before any practice.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href="/signup"
            className={cn(buttonVariants({}), "h-11 px-4")}
          >
            Create a parent account
          </Link>
          <Link
            href="/login"
            className={cn(buttonVariants({ variant: "outline" }), "h-11 px-4")}
          >
            Log in
          </Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Parent account</CardTitle>
              <CardDescription>
                Children do not sign themselves up or grant their own consent.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>A timezone</CardTitle>
              <CardDescription>
                Every child profile stores an IANA timezone from the first save.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Consent first</CardTitle>
              <CardDescription>
                Practice stays closed until you grant it, and you can pause or revoke later.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
        <Card>
          <CardContent className="text-sm leading-6 text-muted-foreground">
            Lessons, scores, and streaks are not in this version. Nothing here
            invents practice progress.
          </CardContent>
        </Card>
      </main>
    </Shell>
  );
}
