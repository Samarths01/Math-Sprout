import type { FourBeat, IntegrityFlag, PublicItem } from "@/lib/attempt-contract";

export function buildFourBeat(input: {
  correct: boolean;
  flags: readonly IntegrityFlag[];
  item: PublicItem;
  canonicalAnswer: string;
}): FourBeat {
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
      oneFocus: "Slow down enough to read the whole question.",
      tryNext: "Give the next one a full look before you answer.",
      lockIn: "That was too fast to count as a careful try.",
    };
  }
  if (input.flags.includes("spam_window")) {
    return {
      whatWentWell: input.correct ? "You reached an answer." : "You kept trying.",
      oneFocus: "Leave a little space between tries.",
      tryNext: "Take the next problem one at a time.",
      lockIn: "This one stays a quiet sprout.",
    };
  }
  if (input.correct) {
    return {
      whatWentWell: `You worked out ${input.item.skill}.`,
      oneFocus: "Keep reading the question all the way through.",
      tryNext: `Try another grade ${input.item.grade} ${input.item.pack} problem.`,
      lockIn: "That is the answer we were looking for.",
    };
  }
  return {
    whatWentWell: "You committed to an answer.",
    oneFocus: `Look again at ${input.item.skill}.`,
    tryNext: "Try one more like this, a little slower.",
    lockIn: `The answer we were looking for is ${input.canonicalAnswer}.`,
  };
}
