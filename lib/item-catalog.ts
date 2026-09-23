import type { PublicItem } from "@/lib/attempt-contract";

/**
 * Grades 2–4 operations plus a fractions pack.
 * This catalog is safe to import from the client. It has no answers.
 */
export const ITEM_CATALOG: PublicItem[] = [
  {
    id: "ops-g2-add",
    pack: "operations",
    grade: 2,
    skill: "adding two-digit numbers",
    prompt: "What is 27 + 15?",
  },
  {
    id: "ops-g2-sub",
    pack: "operations",
    grade: 2,
    skill: "subtracting two-digit numbers",
    prompt: "What is 63 - 18?",
  },
  {
    id: "ops-g3-mul",
    pack: "operations",
    grade: 3,
    skill: "multiplying within 100",
    prompt: "What is 7 × 8?",
  },
  {
    id: "ops-g3-div",
    pack: "operations",
    grade: 3,
    skill: "dividing within 100",
    prompt: "What is 56 ÷ 7?",
  },
  {
    id: "ops-g4-mul",
    pack: "operations",
    grade: 4,
    skill: "multiplying a two-digit number by one digit",
    prompt: "What is 24 × 3?",
  },
  {
    id: "ops-g4-div",
    pack: "operations",
    grade: 4,
    skill: "dividing a two-digit number",
    prompt: "What is 96 ÷ 4?",
  },
  {
    id: "frac-g2-compare",
    pack: "fractions",
    grade: 2,
    skill: "comparing unit fractions",
    prompt: "Which is larger, 1/2 or 1/4?",
  },
  {
    id: "frac-g3-equiv",
    pack: "fractions",
    grade: 3,
    skill: "finding an equivalent fraction",
    prompt: "Which fraction equals 1/2? Answer 2/4 or 2/3.",
  },
  {
    id: "frac-g3-add",
    pack: "fractions",
    grade: 3,
    skill: "adding fractions with the same denominator",
    prompt: "What is 1/4 + 2/4?",
  },
  {
    id: "frac-g4-add",
    pack: "fractions",
    grade: 4,
    skill: "adding fractions with different denominators",
    prompt: "What is 1/2 + 1/4?",
  },
  {
    id: "frac-g4-sub",
    pack: "fractions",
    grade: 4,
    skill: "subtracting fractions with the same denominator",
    prompt: "What is 3/4 - 1/4?",
  },
];

export function itemAt(index: number): PublicItem {
  if (ITEM_CATALOG.length === 0) {
    throw new Error("Practice catalog is empty.");
  }
  const normalized = ((index % ITEM_CATALOG.length) + ITEM_CATALOG.length) % ITEM_CATALOG.length;
  return ITEM_CATALOG[normalized];
}

export function catalogItem(id: string): PublicItem | undefined {
  return ITEM_CATALOG.find((item) => item.id === id);
}
