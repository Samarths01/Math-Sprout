import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { CreateChildForm } from "@/components/create-child-form";
import { LogoutButton } from "@/components/logout-button";
import { Shell } from "@/components/shell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { currentGuardian } from "@/lib/http";

export const metadata = { title: "Add a child" };

export default async function NewChildPage() {
  const guardian = await currentGuardian();
  if (!guardian) redirect("/login");

  return (
    <Shell width="narrow">
      <AppHeader eyebrow="Add a child" action={<LogoutButton />} />
      <Card>
        <CardHeader>
          <CardTitle className="font-heading text-2xl">Child profile</CardTitle>
          <CardDescription>
            A name and a timezone. You can grant, pause, or revoke consent
            after the profile is saved.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <CreateChildForm guardianTimezone={guardian.timezone} />
          <Link
            href="/parent"
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Back to parent home
          </Link>
        </CardContent>
      </Card>
    </Shell>
  );
}
