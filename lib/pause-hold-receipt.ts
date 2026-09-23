/** Bounded parent-receipt posts. A miss stays held. It never becomes a drop. */
export const PAUSE_HOLD_RECEIPT_TRIES = 4;

export type PauseHoldReceiptOptions = {
  tries?: number;
  wait?: (attempt: number) => Promise<void>;
};

function defaultWait(attempt: number): Promise<void> {
  const delay = Math.min(250 * attempt, 1000);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Post the parent-visible pause receipt until it is visible, or until the bound.
 * The caller keeps the try on hold either way. A failed post is not a drop.
 */
export async function postPauseHoldUntilVisible(
  post: () => Promise<boolean>,
  options: PauseHoldReceiptOptions = {},
): Promise<boolean> {
  const tries = options.tries ?? PAUSE_HOLD_RECEIPT_TRIES;
  const wait = options.wait ?? defaultWait;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (attempt > 0) await wait(attempt);
    try {
      if (await post()) return true;
    } catch {
      // The device queue stays held. The next flush tries the receipt again.
    }
  }
  return false;
}
