import { parseAnswer, rationalsEqual } from "@/lib/answer-parser";
import type { AnswerKind } from "@/lib/unparseable";

const WHOLE_EXAMPLE = "3";
const WHOLE_FALLBACK = "4";
const FRACTION_EXAMPLE = "1/2";
const FRACTION_FALLBACK = "1/3";

/**
 * Declared on the template family. A fraction template stays `fraction`
 * even when one draw simplifies to a whole number such as 4/4.
 */
export function answerKindForTemplate(family: string): AnswerKind {
  return family.startsWith("frac_") ? "fraction" : "whole";
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
 * Server-chosen hint example for a template's declared answer kind.
 * Never equal to the canonical answer, including equivalent writings
 * such as 2/4 and 1/2. The client receives only the result.
 */
export function formatExampleFor(
  answerKind: AnswerKind,
  canonical: string,
): {
  answerKind: AnswerKind;
  formatExample: string;
} {
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
