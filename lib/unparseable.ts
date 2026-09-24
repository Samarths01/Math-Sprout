/**
 * Interface has not chosen whether an unparseable answer locks the item
 * or lets the child retry. Change this one line when it does.
 * `submitAttempt` is the only reader.
 */
export const UNPARSEABLE_BEHAVIORS = ["lock", "retry"] as const;
export type UnparseableBehavior = (typeof UNPARSEABLE_BEHAVIORS)[number];

export const UNPARSEABLE_BEHAVIOR: UnparseableBehavior = "lock";

const UNPARSEABLE_COPY: Record<UnparseableBehavior, string> = {
  lock: "That answer stays quiet.",
  retry: "Type a number like 3 or 1/2.",
};

/** Child line for the chosen branch. Does not read `UNPARSEABLE_BEHAVIOR`. */
export function unparseableChildLine(behavior: UnparseableBehavior): string {
  return UNPARSEABLE_COPY[behavior];
}
