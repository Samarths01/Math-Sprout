"use client";

import { useEffect } from "react";
import type { AnswerKind } from "@/lib/unparseable";
import { Input } from "@/components/ui/input";

/**
 * The answer blank plus the one slate hint that sits directly under it.
 * The typed text stays in the field. A new hint selects that text.
 */
export function AnswerBlank({
  value,
  hint,
  answerKind,
  disabled,
  locked = false,
  onValueChange,
  inputId = "practice-answer",
  form,
  className,
}: {
  value: string;
  hint: string | null;
  answerKind: AnswerKind;
  disabled?: boolean;
  locked?: boolean;
  onValueChange: (next: string) => void;
  inputId?: string;
  form?: string;
  className?: string;
}) {
  const fraction = answerKind === "fraction";
  useEffect(() => {
    const node = document.getElementById(inputId);
    if (!(node instanceof HTMLInputElement)) return;
    node.setAttribute("inputmode", fraction ? "text" : "numeric");
    node.setAttribute("pattern", fraction ? "[0-9]+/[0-9]+" : "[0-9]*");
    if (!hint) return;
    node.focus();
    node.select();
  }, [hint, inputId, fraction]);

  return (
    <div className="grid gap-1">
      <Input
        id={inputId}
        form={form}
        data-testid="practice-answer"
        data-answer-kind={answerKind}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        inputMode={fraction ? "text" : "numeric"}
        pattern={fraction ? "[0-9]+/[0-9]+" : "[0-9]*"}
        autoComplete="off"
        disabled={disabled}
        aria-label="Your answer"
        aria-describedby={hint ? "format-hint" : undefined}
        className={className}
      />
      {hint ? (
        <p
          id="format-hint"
          role="status"
          data-testid="format-hint"
          data-format-locked={locked ? "true" : "false"}
          className="text-label text-sm leading-6"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
