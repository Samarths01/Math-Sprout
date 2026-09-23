import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { AuthForm } from "@/components/auth-form";
import { Shell } from "@/components/shell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { currentGuardian } from "@/lib/http";

export const dynamic = "force-dynamic";

export const metadata = { title: "Create a parent account" };

export default async function SignupPage() {
  if (await currentGuardian()) redirect("/parent");

  return (
    <Shell width="narrow">
      <AppHeader eyebrow="Parent signup" />
      <Card>
        <CardHeader>
          <CardTitle className="font-heading text-2xl">
            Create a parent account
          </CardTitle>
          <CardDescription>
            You are the guardian. A child under 13 does not create this account
            or grant consent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AuthForm mode="signup" />
        </CardContent>
      </Card>
    </Shell>
  );
}
