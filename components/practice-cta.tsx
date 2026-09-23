"use client";

import { useState } from "react";
import { practiceClickOutcome } from "@/lib/practice-gate";
import { Button } from "@/components/ui/button";

export function PracticeCta({
  practiceAllowed,
  reason,
}: {
  practiceAllowed: boolean;
  reason?: string;
}) {
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className="grid gap-3">
      <Button
        type="button"
        data-testid="practice-cta"
        data-practice-allowed={practiceAllowed ? "true" : "false"}
        disabled={!practiceAllowed}
        aria-disabled={!practiceAllowed}
        aria-describedby="practice-gate-copy"
        className="h-14 w-full text-base"
        onClick={() => {
          const outcome = practiceClickOutcome(practiceAllowed);
          if (outcome === "blocked") return;
          setNote(
            "Practice is allowed, and no session was started. Lessons are not part of this version.",
          );
        }}
      >
        Start practice
      </Button>
      <p id="practice-gate-copy" className="text-sm leading-6 text-muted-foreground">
        {practiceAllowed
          ? "A parent has granted consent. This version still does not open a practice session."
          : reason}
      </p>
      {note ? (
        <p role="status" className="text-sm text-foreground">
          {note}
        </p>
      ) : null}
    </div>
  );
}
