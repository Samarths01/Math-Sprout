import { catalogItem, ITEM_CATALOG } from "@/lib/item-catalog";

/**
 * Item Bank misconception tags. The server assembles oneFocus from these.
 * The client catalog does not carry them.
 */
const ITEM_TAGS: Record<string, { misconception: string; whyItWorks?: string }> = {
  "ops-g2-add": {
    misconception: "regrouping when the ones pass nine",
    whyItWorks: "Add the ones first. 7 + 5 is 12, so write 2 and carry 1 ten.",
  },
  "ops-g2-sub": { misconception: "regrouping when the top ones are smaller" },
  "ops-g3-mul": { misconception: "the product of the two factors" },
  "ops-g3-div": { misconception: "how many equal groups fit in the whole" },
  "ops-g4-mul": { misconception: "the ones place before the tens place" },
  "ops-g4-div": { misconception: "splitting the dividend into equal groups" },
  "frac-g2-compare": { misconception: "a larger piece when the denominator is smaller" },
  "frac-g3-equiv": { misconception: "the same amount written with another denominator" },
  "frac-g3-add": { misconception: "adding numerators and keeping the denominator" },
  "frac-g4-add": { misconception: "finding a common denominator before adding" },
  "frac-g4-sub": { misconception: "subtracting numerators and keeping the denominator" },
};

const ANSWERS: Record<string, readonly string[]> = {
  "ops-g2-add": ["42"],
  "ops-g2-sub": ["45"],
  "ops-g3-mul": ["56"],
  "ops-g3-div": ["8"],
  "ops-g4-mul": ["72"],
  "ops-g4-div": ["24"],
  "frac-g2-compare": ["1/2"],
  "frac-g3-equiv": ["2/4"],
  "frac-g3-add": ["3/4"],
  "frac-g4-add": ["3/4"],
  "frac-g4-sub": ["1/2", "2/4"],
};

export function normalizeAnswer(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

export function knownItem(id: string): boolean {
  return Boolean(catalogItem(id) && ANSWERS[id]?.length);
}

export function canonicalAnswer(itemId: string): string {
  return ANSWERS[itemId]?.[0] ?? "";
}

export function gradeAnswer(itemId: string, answer: string): boolean {
  const accepted = ANSWERS[itemId];
  if (!accepted) return false;
  const normalized = normalizeAnswer(answer);
  if (!normalized) return false;
  return accepted.some((candidate) => normalizeAnswer(candidate) === normalized);
}

/**
 * Server cue from the item's misconception tag.
 * Production does not ask a model to write this line. Practice renders it as sent.
 */
export function oneFocusForItem(itemId: string): string {
  const tag = ITEM_TAGS[itemId];
  if (!tag) throw new Error(`Item ${itemId} is missing a misconception tag.`);
  const misconception = tag.misconception.trim();
  if (!misconception) return "";
  return `Watch ${misconception}.`;
}

/**
 * Solidify line from the item bank. Empty when the bank has no whyItWorks string.
 * Practice omits that beat. This is not filled in by a model.
 */
export function whyItWorksForItem(itemId: string): string {
  return ITEM_TAGS[itemId]?.whyItWorks?.trim() ?? "";
}

/** Supporting beat, assembled from the same tag as oneFocus. */
export function tryNextForItem(itemId: string): string {
  const tag = ITEM_TAGS[itemId];
  if (!tag) throw new Error(`Item ${itemId} is missing a misconception tag.`);
  const misconception = tag.misconception.trim();
  if (!misconception) return "";
  return `Try again and watch ${misconception}.`;
}

export function assertBankMatchesCatalog(): void {
  const catalogIds = ITEM_CATALOG.map((item) => item.id);
  const answerIds = Object.keys(ANSWERS);
  const missing = catalogIds.filter((id) => !ANSWERS[id]?.length);
  const extra = answerIds.filter((id) => !catalogIds.includes(id));
  const untagged = catalogIds.filter((id) => !ITEM_TAGS[id]);
  if (missing.length > 0 || extra.length > 0 || untagged.length > 0) {
    throw new Error(
      `Item bank is out of sync. Missing answers: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}. Missing tags: ${untagged.join(", ") || "none"}.`,
    );
  }
}
