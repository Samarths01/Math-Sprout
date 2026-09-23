import type { ReactNode } from "react";
import Link from "next/link";
import { SproutMark } from "@/components/sprout-mark";

export function AppHeader({
  eyebrow,
  action,
}: {
  eyebrow: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-3">
      <Link href="/" className="flex items-center gap-3 text-primary">
        <SproutMark className="size-11 shrink-0" />
        <span>
          <span className="block font-heading text-xl leading-none tracking-tight">
            Math Sprout
          </span>
          <span className="mt-1 block text-sm text-muted-foreground">{eyebrow}</span>
        </span>
      </Link>
      {action}
    </header>
  );
}
