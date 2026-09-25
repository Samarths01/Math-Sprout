/**
 * Fraction answers are compared as reduced rationals.
 * Mixed numbers and improper fractions share a value unless a template
 * requires one written form. Parsing lives in `lib/answer-parser.ts`.
 */

import { gcd, parseAnswer, rationalKey, rationalsEqual } from "@/lib/answer-parser";

export type { ParsedAnswer, Rational } from "@/lib/answer-parser";
export {
  formatRational,
  gcd,
  parseAnswer,
  rationalKey,
  rationalsEqual,
  reduce,
} from "@/lib/answer-parser";

export type RequireForm = "lowest_terms" | "mixed" | "improper";

function cleanup(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Value match, then an optional written-form gate.
 * `exact` keeps a legacy choice such as 2/4 from matching 1/2.
 */
export function answersMatch(
  expected: string,
  given: string,
  mode: "rational" | "exact",
  requireForm: RequireForm | null,
): "blank" | "unparseable" | "correct" | "incorrect" | "form_mismatch" {
  if (given.trim().length === 0) return "blank";
  if (mode === "exact") {
    const left = cleanup(expected).replace(/\s+/g, "");
    const right = cleanup(given).replace(/\s+/g, "");
    if (!right) return "blank";
    const parsed = parseAnswer(given);
    if (parsed.kind === "unparseable" || parsed.kind === "blank") return "unparseable";
    return left === right ? "correct" : "incorrect";
  }
  const want = parseAnswer(expected);
  const got = parseAnswer(given);
  if (got.kind === "blank") return "blank";
  if (want.kind !== "rational" && want.kind !== "symbol") return "unparseable";
  if (got.kind === "unparseable") return "unparseable";
  if (want.kind === "symbol" || got.kind === "symbol") {
    if (want.kind === "symbol" && got.kind === "symbol") {
      return want.symbol === got.symbol ? "correct" : "incorrect";
    }
    return "incorrect";
  }
  if (want.kind !== "rational" || got.kind !== "rational") return "incorrect";
  if (!rationalsEqual(want.value, got.value)) return "incorrect";
  if (!requireForm) return "correct";
  if (requireForm === "mixed") return got.form === "mixed" ? "correct" : "form_mismatch";
  if (requireForm === "improper") {
    return got.form === "improper" ? "correct" : "form_mismatch";
  }
  if (got.form === "integer" || got.form === "lowest_terms") return "correct";
  if (got.form === "mixed" || got.form === "improper") {
    return fractionPartReduced(got.written) ? "correct" : "form_mismatch";
  }
  return "form_mismatch";
}

/** Lowest terms means the fraction part cannot be reduced. Mixed and improper both qualify. */
function fractionPartReduced(written: string): boolean {
  const mixed = written.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return gcd(Number(mixed[2]), Number(mixed[3])) === 1;
  const fraction = written.match(/^(-?\d+)\/(\d+)$/);
  if (!fraction) return /^-?\d+$/.test(written);
  return gcd(Number(fraction[1]), Number(fraction[2])) === 1;
}

/** Collision key for operands plus the answer value. */
export function canonicalValueKey(answer: string): string {
  const parsed = parseAnswer(answer);
  if (parsed.kind === "rational") return rationalKey(parsed.value);
  if (parsed.kind === "symbol") return parsed.symbol;
  return cleanup(answer);
}
