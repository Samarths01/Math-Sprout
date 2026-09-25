import type { ReactNode } from "react";
import type { PublicItem } from "@/lib/attempt-contract";
import { stepClass } from "@/lib/palette";

/**
 * Problem chrome. The concept name is the header. A skill change is not a toast.
 */
export function PracticeProblem({
  item,
  answerSlot,
}: {
  item: PublicItem;
  answerSlot?: ReactNode;
}) {
  const word = item.stepWord ?? "Warm-up";
  return (
    <div data-testid="practice-problem" className="grid gap-3">
      <div className="flex items-center gap-2 text-sm">
        <span
          data-testid="difficulty-badge"
          data-grade={item.grade}
          className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${stepClass(item.grade)}`}
        >
          Grade {item.grade}
        </span>
        <span
          data-testid="step-word"
          className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${stepClass(2)}`}
        >
          {word}
        </span>
        <span data-testid="concept-name">{item.skill}</span>
        <span>{item.pack === "fractions" ? "Fractions" : "Operations"}</span>
      </div>
      {item.layout === "column" && item.columnLines && item.columnLines.length > 0 ? (
        <pre
          data-testid="column-problem"
          className="font-heading text-[32px] leading-[40px] tracking-tight tabular-nums"
        >
          {item.columnLines.join("\n")}
        </pre>
      ) : null}
      {item.blankInline ? (
        <div
          data-testid="inline-equation"
          className="flex flex-wrap items-center gap-2 font-heading text-[32px] leading-[40px] tracking-tight tabular-nums"
        >
          <span>{item.blankInline.leading}</span>
          {answerSlot}
          <span>{item.blankInline.trailing}</span>
        </div>
      ) : (
        <h2
          data-testid="practice-prompt"
          className="font-heading text-[32px] leading-[40px] tracking-tight tabular-nums"
        >
          {item.prompt}
        </h2>
      )}
    </div>
  );
}
