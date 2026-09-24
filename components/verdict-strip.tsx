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
          ? "flex h-12 w-full items-center gap-2 rounded-[12px] bg-verdict-correct/12 px-3 font-sans text-[20px] font-bold text-verdict-correct"
          : "flex h-12 w-full items-center gap-2 rounded-[12px] bg-verdict-miss/12 px-3 font-sans text-[20px] font-bold text-verdict-miss"
      }
    >
      {correct ? (
        <Check className="size-6 shrink-0" aria-hidden="true" />
      ) : (
        <MissMark />
      )}
      {correct ? "Correct" : "Not yet"}
    </p>
  );
}

function MissMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-6 shrink-0" aria-hidden="true">
      <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
