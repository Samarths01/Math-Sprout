import type { FourBeat, IntegrityFlag, PublicItem } from "@/lib/attempt-contract";
import { oneFocusForItem, tryNextForItem, whyItWorksForItem } from "@/lib/item-bank";
import { unparseableChildLine, type UnparseableBehavior } from "@/lib/unparseable";

/** The value once. Arithmetic stems become `27 + 15 = 42`. */
export function answerStamp(prompt: string, canonicalAnswer: string): string {
  const arithmetic = prompt.match(/^What is (.+)\?$/);
  if (arithmetic && canonicalAnswer) return `${arithmetic[1]} = ${canonicalAnswer}`;
  return canonicalAnswer;
}

export function buildFourBeat(input: {
  correct: boolean;
  flags: readonly IntegrityFlag[];
  item: PublicItem;
  canonicalAnswer: string;
  /** Frozen completed equation. Scoring does not rebuild it. */
  answerLine?: string;
  /** Miss focus assembled from a cue key. Empty omits the beat. */
  focus?: string;
  tryNext?: string;
  /** Correct-path solidify. Empty omits Why it works. */
  solidify?: string;
  unparseable?: boolean;
  /** Branch already chosen by `submitAttempt`. This file does not read the seam. */
  unparseableBehavior?: UnparseableBehavior;
}): FourBeat {
  if (input.unparseable) {
    return {
      whatWentWell: "You stayed with the problem.",
      oneFocus: "",
      tryNext: "",
      lockIn: unparseableChildLine(input.unparseableBehavior ?? "lock"),
    };
  }
  const answer = input.answerLine ?? answerStamp(input.item.prompt, input.canonicalAnswer);
  const solidify = input.solidify !== undefined ? input.solidify : whyItWorksForItem(input.item.id);
  const missFocus = input.focus !== undefined ? input.focus : oneFocusForItem(input.item.id);
  const missNext = input.tryNext !== undefined ? input.tryNext : tryNextForItem(input.item.id);
  if (input.flags.includes("empty_answer")) {
    return {
      whatWentWell: "You stayed with the problem.",
      oneFocus: "Write an answer before you check.",
      tryNext: "Put an answer in, then try the check again.",
      lockIn: "A blank answer stays quiet.",
    };
  }
  if (input.flags.includes("too_fast")) {
    return {
      whatWentWell: input.correct
        ? "The answer matches."
        : "You put an answer down.",
      oneFocus: input.correct ? solidify : "Slow down enough to read the whole question.",
      tryNext: input.correct
        ? "That was too fast to count as a careful try. Give the next one a full look before you answer."
        : "Give the next one a full look before you answer.",
      lockIn: input.correct ? answer : "That was too fast to count as a careful try.",
    };
  }
  if (input.flags.includes("spam_window")) {
    return {
      whatWentWell: input.correct ? "You reached an answer." : "You kept trying.",
      oneFocus: input.correct ? solidify : "Leave a little space between tries.",
      tryNext: input.correct
        ? "This one stays a quiet sprout. Take the next problem one at a time."
        : "Take the next problem one at a time.",
      lockIn: input.correct ? answer : "This one stays a quiet sprout.",
    };
  }
  if (input.correct) {
    return {
      whatWentWell: `You worked out ${input.item.skill}.`,
      oneFocus: solidify,
      tryNext: `Try another grade ${input.item.grade} ${input.item.pack} problem.`,
      lockIn: answer,
    };
  }
  return {
    whatWentWell: "You committed to an answer.",
    oneFocus: missFocus,
    tryNext: missNext,
    lockIn: answer,
  };
}
