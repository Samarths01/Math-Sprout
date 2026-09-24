import { Check } from "lucide-react";

/**
 * Right/wrong under the stem, before the beats.
 * Correct is the only green. A miss is calm blue.
 */
export function VerdictStrip({ correct }: { correct: boolean }) {
  return (
    <p
      data-testid="verdict-strip"
      data-correct={correct ? "true" : "false"}
      role="status"
      className={
        correct
          ? "inline-flex w-fit items-center gap-2 rounded-lg bg-verdict-correct/15 px-3 py-2 font-sans text-[1.2rem] font-bold leading-tight text-verdict-correct"
          : "inline-flex w-fit items-center gap-2 rounded-lg bg-verdict-miss/15 px-3 py-2 font-sans text-[1.2rem] font-bold leading-tight text-verdict-miss"
      }
    >
      {correct ? <Check className="size-5 shrink-0" aria-hidden="true" /> : null}
      {correct ? "Correct" : "Not yet"}
    </p>
  );
}
