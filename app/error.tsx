"use client";

import { Button } from "@/components/ui/button";
import { Shell } from "@/components/shell";

export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Shell width="narrow">
      <div className="grid gap-3">
        <h1 className="font-heading text-3xl">Something went wrong</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          Math Sprout could not load this page. Your account data is still on
          the server.
        </p>
        <Button type="button" className="h-11 w-fit" onClick={reset}>
          Try again
        </Button>
      </div>
    </Shell>
  );
}
