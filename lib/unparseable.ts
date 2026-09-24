/**
 * Architecture §29. An unreadable answer is not an attempt.
 * Change `UNPARSEABLE_BEHAVIOR` when Interface picks lock instead of retry.
 * `submitAnswer` is the only reader of that constant.
 */
export const UNPARSEABLE_BEHAVIORS = ["lock", "retry"] as const;
export type UnparseableBehavior = (typeof UNPARSEABLE_BEHAVIORS)[number];

export const UNPARSEABLE_BEHAVIOR: UnparseableBehavior = "retry";

/** Placeholder until Interface confirms the child line. */
export const UNPARSEABLE_HINT = "Type a number like 3 or 1/2.";

const UNPARSEABLE_LOCK_LINE = "That answer stays quiet.";

export type FormatRejected = {
  type: "format_rejected";
  behavior: UnparseableBehavior;
  hint: string;
};

export function unparseableChildLine(behavior: UnparseableBehavior): string {
  return behavior === "retry" ? UNPARSEABLE_HINT : UNPARSEABLE_LOCK_LINE;
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
