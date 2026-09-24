import { Check } from "lucide-react";

/**
 * Right/wrong under the stem, before the beats.
 * Correct is a mint wash with a check. A miss is amber–coral, not alarm red.
 */
export function VerdictStrip({ correct }: { correct: boolean }) {
  return (
    <p
      data-testid="verdict-strip"
      data-correct={correct ? "true" : "false"}
      role="status"
      className={
        correct
          ? "inline-flex w-fit items-center gap-2 rounded-lg bg-secondary px-3 py-2 font-sans text-[1.2rem] font-bold leading-tight text-primary"
          : "inline-flex w-fit items-center gap-2 rounded-lg bg-[oklch(0.94_0.045_55)] px-3 py-2 font-sans text-[1.2rem] font-bold leading-tight text-[oklch(0.40_0.08_45)]"
      }
    >
      {correct ? <Check className="size-5 shrink-0" aria-hidden="true" /> : null}
      {correct ? "Correct" : "Not yet"}
    </p>
  );
}
