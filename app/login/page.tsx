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

export const metadata = { title: "Log in" };

export default async function LoginPage() {
  if (await currentGuardian()) redirect("/parent");

  return (
    <Shell width="narrow">
      <AppHeader eyebrow="Parent login" />
      <Card>
        <CardHeader>
          <CardTitle className="font-heading text-2xl">Welcome back</CardTitle>
          <CardDescription>
            Log in with the parent email you used to create the account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AuthForm mode="login" />
        </CardContent>
      </Card>
    </Shell>
  );
}
