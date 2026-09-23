"use client";

import Link from "next/link";
import { practiceClickOutcome } from "@/lib/practice-gate";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PracticeCta({
  childId,
  practiceAllowed,
  reason,
}: {
  childId: string;
  practiceAllowed: boolean;
  reason?: string;
}) {
  const outcome = practiceClickOutcome(practiceAllowed);

  return (
    <div className="grid gap-3">
      {outcome === "start-session" ? (
        <Link
          href={`/child/${childId}/practice`}
          data-testid="practice-cta"
          data-practice-allowed="true"
          className={cn(buttonVariants(), "h-14 w-full text-base")}
        >
          Start practice
        </Link>
      ) : (
        <button
          type="button"
          data-testid="practice-cta"
          data-practice-allowed="false"
          disabled
          aria-disabled="true"
          aria-describedby="practice-gate-copy"
          className={cn(buttonVariants(), "h-14 w-full text-base")}
        >
          Start practice
        </button>
      )}
      <p id="practice-gate-copy" className="text-sm leading-6 text-muted-foreground">
        {outcome === "start-session"
          ? "A parent has granted consent. Start practice when you are ready."
          : reason}
      </p>
    </div>
  );
}
