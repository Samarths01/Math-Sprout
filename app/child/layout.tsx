import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { currentGuardian } from "@/lib/http";

export const dynamic = "force-dynamic";

export default async function ChildLayout({
  children,
}: {
  children: ReactNode;
}) {
  if (!(await currentGuardian())) redirect("/login");
  return children;
}
