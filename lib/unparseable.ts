/**
 * Architecture §29. An unreadable answer is not an attempt.
 * Change `UNPARSEABLE_BEHAVIOR` when Interface picks lock instead of retry.
 * `submitAnswer` is the only reader of that constant.
 */
export const UNPARSEABLE_BEHAVIORS = ["lock", "retry"] as const;
export type UnparseableBehavior = (typeof UNPARSEABLE_BEHAVIORS)[number];

export const UNPARSEABLE_BEHAVIOR: UnparseableBehavior = "retry";

export const ANSWER_KINDS = ["whole", "fraction"] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

/** Display defaults used only when an issued payload omitted `formatExample`. */
export const FORMAT_EXAMPLE_DEFAULTS: Record<AnswerKind, string> = {
  whole: "3",
  fraction: "1/2",
};

/** Child hint copy. The server fills `{example}` with a non-answer example. */
export const FORMAT_HINT_COPY = {
  whole: "Use numbers only, like {example}.",
  fraction: "Write it as a fraction, like {example}.",
} as const;

export function formatHint(answerKind: AnswerKind, example: string): string {
  return FORMAT_HINT_COPY[answerKind].replaceAll("{example}", example);
}

const UNPARSEABLE_LOCK_LINE = "That answer stays quiet.";

export type FormatRejected = {
  type: "format_rejected";
  behavior: UnparseableBehavior;
  hint: string;
};

export function unparseableChildLine(
  behavior: UnparseableBehavior,
  answerKind: AnswerKind,
  example: string,
): string {
  return behavior === "retry" ? formatHint(answerKind, example) : UNPARSEABLE_LOCK_LINE;
}

export function isFormatRejected(value: unknown): value is FormatRejected {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<FormatRejected>;
  return (
    row.type === "format_rejected" &&
    (row.behavior === "lock" || row.behavior === "retry") &&
    typeof row.hint === "string"
  );
}
