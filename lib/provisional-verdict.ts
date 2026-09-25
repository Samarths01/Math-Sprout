/**
 * Offline verdict before sync. It does not score, reveal an answer, or mint.
 * The server is still the only scorer when the queue syncs.
 */
export type ProvisionalVerdict = {
  pending: true;
  revealsAnswer: false;
  mints: false;
};

export function provisionalVerdict(): ProvisionalVerdict {
  return { pending: true, revealsAnswer: false, mints: false };
}
