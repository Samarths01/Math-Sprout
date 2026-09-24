import type { ReactNode } from "react";
import Link from "next/link";
import { SproutMark } from "@/components/sprout-mark";

export function AppHeader({
  eyebrow,
  action,
}: {
  eyebrow?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-3">
      <Link href="/" className="flex items-center gap-3 text-foreground">
        <SproutMark className="size-11 shrink-0 text-logo" />
        <span>
          <span className="block font-heading text-xl leading-none tracking-tight">
            Math Sprout
          </span>
          {eyebrow ? (
            <span className="mt-1 block text-sm text-muted-foreground">{eyebrow}</span>
          ) : null}
        </span>
      </Link>
      {action}
    </header>
  );
}
