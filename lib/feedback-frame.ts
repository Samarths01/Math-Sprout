import {
  displayedOneFocus,
  FOUR_BEAT_KEYS,
  type FourBeat,
  type FourBeatKey,
} from "@/lib/attempt-contract";

export type FeedbackFrame = {
  key: FourBeatKey;
  label: string;
  text: string;
};

const CORRECT_LABELS: Record<FourBeatKey, string> = {
  whatWentWell: "Nice move",
  oneFocus: "Why it works",
  tryNext: "Try next",
  lockIn: "Answer",
};

const MISS_LABELS: Record<FourBeatKey, string> = {
  whatWentWell: "What you tried",
  oneFocus: "One focus",
  tryNext: "Try next",
  lockIn: "Lock in",
};

/**
 * Same four keys. Labels follow `correct`.
 * An empty string is left out, so a correct try never shows "One focus",
 * and "Why it works" appears only when that string was stored.
 */
export function feedbackFrames(input: FourBeat & { correct: boolean }): FeedbackFrame[] {
  const labels = input.correct ? CORRECT_LABELS : MISS_LABELS;
  const frames: FeedbackFrame[] = [];
  for (const key of FOUR_BEAT_KEYS) {
    const text = (key === "oneFocus" ? displayedOneFocus(input) : input[key]).trim();
    if (text.length === 0) continue;
    frames.push({ key, label: labels[key], text });
  }
  return frames;
}
