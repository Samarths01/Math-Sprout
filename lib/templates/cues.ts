/**
 * Server phrases for focus cue keys. oneFocus is assembled from these.
 * A key that is not in this map is not real, and the beat is omitted.
 */
export const FOCUS_CUES: Record<string, string> = {
  "add.carry": "Watch regrouping when the ones pass nine.",
  "add.place": "Watch the ones place before the tens place.",
  "sub.borrow": "Watch regrouping when the top ones are smaller.",
  "sub.order": "Watch which number you subtract from.",
  "mul.product": "Watch the product of the two factors.",
  "mul.place": "Watch the ones place before the tens place.",
  "div.groups": "Watch how many equal groups fit in the whole.",
  "div.split": "Watch splitting the dividend into equal groups.",
  "frac.unit": "Watch a larger piece when the denominator is smaller.",
  "frac.equiv": "Watch the same amount written with another denominator.",
  "frac.like": "Watch adding numerators and keeping the denominator.",
  "frac.unlike": "Watch finding a common denominator before adding.",
  "frac.sub": "Watch subtracting numerators and keeping the denominator.",
  "frac.lowest": "Watch dividing the numerator and the denominator by the same number.",
  "frac.form": "Watch how a mixed number and an improper fraction name the same amount.",
};

export function cueText(cueKey: string | undefined): string {
  if (!cueKey) return "";
  return FOCUS_CUES[cueKey]?.trim() ?? "";
}

export function tryNextFromCue(cueKey: string | undefined): string {
  const line = cueText(cueKey);
  if (!line) return "";
  if (line.startsWith("Watch ")) return `Try again and watch ${line.slice("Watch ".length)}`;
  return `Try again and watch ${line}`;
}
