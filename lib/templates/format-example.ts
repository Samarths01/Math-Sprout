import { parseAnswer, rationalsEqual } from "@/lib/answer-parser";
import type { AnswerKind } from "@/lib/unparseable";

const WHOLE_EXAMPLE = "3";
const WHOLE_FALLBACK = "4";
const FRACTION_EXAMPLE = "1/2";
const FRACTION_FALLBACK = "1/3";

/** Whole unless the stored answer is a fraction or mixed number. Symbols stay whole. */
export function answerKindFor(canonical: string): AnswerKind {
  const parsed = parseAnswer(canonical);
  if (parsed.kind === "rational" && parsed.form !== "integer") return "fraction";
  return "whole";
}

function equivalent(canonical: string, example: string): boolean {
  const left = parseAnswer(canonical);
  const right = parseAnswer(example);
  if (left.kind === "rational" && right.kind === "rational") {
    return rationalsEqual(left.value, right.value);
  }
  return canonical.trim() === example;
}

/**
 * Server-chosen hint example. Never equal to the canonical answer, including
 * equivalent writings such as 2/4 and 1/2. The client receives only the result.
 */
export function formatExampleFor(canonical: string): {
  answerKind: AnswerKind;
  formatExample: string;
} {
  const answerKind = answerKindFor(canonical);
  if (answerKind === "whole") {
    return {
      answerKind,
      formatExample: equivalent(canonical, WHOLE_EXAMPLE) ? WHOLE_FALLBACK : WHOLE_EXAMPLE,
    };
  }
  return {
    answerKind,
    formatExample: equivalent(canonical, FRACTION_EXAMPLE) ? FRACTION_FALLBACK : FRACTION_EXAMPLE,
  };
}
