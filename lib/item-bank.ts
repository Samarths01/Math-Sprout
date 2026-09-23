import { catalogItem, ITEM_CATALOG } from "@/lib/item-catalog";

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

export function assertBankMatchesCatalog(): void {
  const catalogIds = ITEM_CATALOG.map((item) => item.id);
  const answerIds = Object.keys(ANSWERS);
  const missing = catalogIds.filter((id) => !ANSWERS[id]?.length);
  const extra = answerIds.filter((id) => !catalogIds.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Item bank is out of sync. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`,
    );
  }
}
