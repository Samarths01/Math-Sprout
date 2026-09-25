import { cueText } from "@/lib/templates/cues";
import { parseAnswer } from "@/lib/answer-parser";
import {
  canonicalValueKey,
  formatRational,
  gcd,
  reduce,
  type RequireForm,
} from "@/lib/templates/rational";
import {
  ANSWER_OPS,
  BUG_OPS,
  type BugHit,
  type Constraint,
  type Draw,
  type FeatureRange,
  type MeasuredFeatures,
  type TemplateVersion,
} from "@/lib/templates/types";

export type Rng = () => number;

type Work = Record<string, number>;

function digitsOf(value: number): number {
  const abs = Math.abs(Math.trunc(value));
  return Math.max(1, String(abs).length);
}

export function addRegroups(a: number, b: number): number {
  let count = 0;
  let carry = 0;
  let left = Math.abs(Math.trunc(a));
  let right = Math.abs(Math.trunc(b));
  while (left > 0 || right > 0 || carry > 0) {
    const sum = (left % 10) + (right % 10) + carry;
    if (sum >= 10) count += 1;
    carry = sum >= 10 ? 1 : 0;
    left = Math.floor(left / 10);
    right = Math.floor(right / 10);
    if (left === 0 && right === 0) break;
  }
  return count;
}

export function subBorrows(a: number, b: number): number {
  let count = 0;
  let borrow = 0;
  let left = Math.abs(Math.trunc(a));
  let right = Math.abs(Math.trunc(b));
  if (left < right) return 0;
  while (left > 0 || right > 0) {
    const top = (left % 10) - borrow;
    const bot = right % 10;
    if (top < bot) {
      count += 1;
      borrow = 1;
    } else {
      borrow = 0;
    }
    left = Math.floor(left / 10);
    right = Math.floor(right / 10);
  }
  return count;
}

export function mulCarries(a: number, factor: number): number {
  let count = 0;
  let carry = 0;
  let left = Math.abs(Math.trunc(a));
  const right = Math.abs(Math.trunc(factor));
  while (left > 0) {
    const prod = (left % 10) * right + carry;
    if (prod >= 10) count += 1;
    carry = Math.floor(prod / 10);
    left = Math.floor(left / 10);
  }
  return count;
}

function denomRelation(
  d1: number,
  d2: number,
): "like" | "multiple" | "unlike" | "unit" {
  if (d1 === d2) return "like";
  if (d1 % d2 === 0 || d2 % d1 === 0) return "multiple";
  return "unlike";
}

function inPair(value: number, range: [number, number]): boolean {
  return value >= range[0] && value <= range[1];
}

export function featuresMatch(features: MeasuredFeatures, range: FeatureRange): boolean {
  if (!inPair(features.digits, range.digits)) return false;
  if (!inPair(features.regroups, range.regroups)) return false;
  if (!inPair(features.borrows, range.borrows)) return false;
  if (!inPair(features.span, range.span)) return false;
  if (features.blank !== range.blank) return false;
  if (range.likeDenominators !== null && features.likeDenominators !== range.likeDenominators) {
    return false;
  }
  if (range.denomRelation !== null && features.denomRelation !== range.denomRelation) {
    return false;
  }
  return true;
}

function drawInt(rng: Rng, min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function fill(pattern: string, values: Record<string, string>): string {
  return pattern.replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? "");
}

function strMap(work: Work, answer: string): Record<string, string> {
  const values: Record<string, string> = { answer };
  for (const [key, value] of Object.entries(work)) values[key] = String(value);
  return values;
}

/** Derived numbers the constraints and the oracle both need. */
export function deriveWork(answerOp: string, drawn: Work): Work | null {
  const work: Work = { ...drawn };
  if (answerOp === "add_gap") {
    if (work.sum === undefined || work.a === undefined || work.sum <= work.a) return null;
    work.b = work.sum - work.a;
  } else if (answerOp === "add_gap_left") {
    if (work.sum === undefined || work.b === undefined || work.sum <= work.b) return null;
    work.a = work.sum - work.b;
  } else if (answerOp === "sub_gap") {
    if (work.a === undefined || work.diff === undefined || work.a <= work.diff) return null;
    work.b = work.a - work.diff;
  } else if (answerOp === "mul_gap") {
    if (!work.a || work.product === undefined || work.product % work.a !== 0) return null;
    work.b = work.product / work.a;
    if (work.b < 1) return null;
  } else if (answerOp === "mul_gap_left") {
    if (!work.b || work.product === undefined || work.product % work.b !== 0) return null;
    work.a = work.product / work.b;
    if (work.a < 1) return null;
  } else if (answerOp === "div_gap") {
    if (!work.q || work.a === undefined || work.a % work.q !== 0) return null;
    work.b = work.a / work.q;
    if (work.b < 1) return null;
  } else if (answerOp === "div_gap_left") {
    if (work.b === undefined || work.q === undefined) return null;
    work.a = work.b * work.q;
  } else if (answerOp === "frac_add_gap") {
    if (work.sumN === undefined || work.n1 === undefined || work.sumN <= work.n1) return null;
    work.n2 = work.sumN - work.n1;
  } else if (answerOp === "quot" || answerOp === "divisor") {
    if ((work.b ?? 0) < 1 || (work.q ?? 0) < 1) return null;
    work.a = work.b * work.q;
  } else if (answerOp === "dividend") {
    if ((work.b ?? 0) < 1 || (work.q ?? 0) < 1) return null;
    work.a = work.b * work.q;
  } else if (answerOp === "blank_b" || answerOp === "blank_a") {
    if ((work.a ?? 0) < 1 || (work.b ?? 0) < 1) return null;
    work.product = work.a * work.b;
  } else if (answerOp === "scale_num" || answerOp === "scale_exact") {
    if ((work.d ?? 0) < 1 || (work.k ?? 0) < 1) return null;
    work.den = work.d * work.k;
  }
  return work;
}

export function constraintHolds(
  constraint: Constraint,
  answerOp: string,
  work: Work,
  drawn: Work = work,
): boolean {
  const a = work.a ?? 0;
  const b = work.b ?? 0;
  const spanValues = Object.values(drawn).filter((value) => Number.isFinite(value));
  const span = spanValues.length > 0 ? Math.max(...spanValues) : 0;
  switch (constraint.op) {
    case "add_regroups_eq":
      return addRegroups(a, b) === constraint.value;
    case "add_regroups_gte":
      return addRegroups(a, b) >= constraint.value;
    case "sub_borrows_eq":
      return a > b && subBorrows(a, b) === constraint.value;
    case "sub_borrows_gte":
      return a > b && subBorrows(a, b) >= constraint.value;
    case "mul_carries_eq":
      return mulCarries(a, b) === constraint.value;
    case "mul_carries_gte":
      return mulCarries(a, b) >= constraint.value;
    case "gt_left":
      return a > b;
    case "div_exact":
      return b !== 0 && a % b === 0;
    case "product_le":
      return (work.q !== undefined ? (work.a ?? 0) : a * b) <= constraint.value;
    case "product_ge":
      return (work.q !== undefined ? (work.a ?? 0) : a * b) >= constraint.value;
    case "sum_lt_den":
      return (work.n1 ?? 0) + (work.n2 ?? 0) < (work.d ?? work.d1 ?? 0);
    case "sum_eq_den":
      return (work.n1 ?? 0) + (work.n2 ?? 0) === (work.d ?? 0);
    case "sum_gt_den":
      return (work.n1 ?? 0) + (work.n2 ?? 0) > (work.d ?? 0);
    case "diff_positive":
      return (work.n1 ?? 0) > (work.n2 ?? 0);
    case "result_reduces": {
      const num = (work.n1 ?? 0) - (work.n2 ?? 0);
      const den = work.d ?? 1;
      return num > 0 && gcd(num, den) > 1;
    }
    case "result_lowest": {
      const num = (work.n1 ?? 0) - (work.n2 ?? 0);
      const den = work.d ?? 1;
      return num > 0 && gcd(num, den) === 1;
    }
    case "span_between":
      return span >= constraint.min && span <= constraint.max;
    case "den_multiple": {
      const d1 = work.d1 ?? 0;
      const d2 = work.d2 ?? 0;
      return d1 !== d2 && d1 > 0 && d2 > 0 && (d1 % d2 === 0 || d2 % d1 === 0);
    }
    case "den_unlike": {
      const d1 = work.d1 ?? 0;
      const d2 = work.d2 ?? 0;
      return d1 > 0 && d2 > 0 && d1 % d2 !== 0 && d2 % d1 !== 0;
    }
    case "like_den":
      return (work.d1 ?? work.d ?? 0) > 0 && (work.d1 ?? work.d) === (work.d2 ?? work.d);
    case "gcd_gt_one":
      return gcd(work.n ?? 0, work.d ?? 0) > 1;
    case "proper_part":
      return (work.n ?? 0) > 0 && (work.d ?? 0) > (work.n ?? 0);
    case "improper_source":
      return (work.d ?? 0) > 1 && (work.n ?? 0) > (work.d ?? 0) && (work.n ?? 0) % (work.d ?? 1) !== 0;
    case "ones_sum_gte":
      return (Math.abs(a) % 10) + (Math.abs(b) % 10) >= constraint.value;
    case "factors_below":
      return a < constraint.value && b < constraint.value;
    default:
      return false;
  }
}

export function measureFeatures(
  template: TemplateVersion,
  drawn: Work,
  work: Work,
): MeasuredFeatures {
  const spanSource =
    template.spec.family === "div" && work.a !== undefined ? [work.a] : Object.values(drawn);
  const span = spanSource.length > 0 ? Math.max(...spanSource) : 0;
  const digits = spanSource.length > 0 ? Math.max(...spanSource.map(digitsOf)) : 1;
  const family = template.spec.family;
  let regroups = 0;
  let borrows = 0;
  let likeDenominators: boolean | null = null;
  let relation: MeasuredFeatures["denomRelation"] = "na";
  if (family === "add" || template.spec.answerOp.startsWith("add")) {
    regroups = addRegroups(work.a ?? 0, work.b ?? 0);
  } else if (family === "sub" || template.spec.answerOp.startsWith("sub")) {
    borrows = subBorrows(work.a ?? 0, work.b ?? 0);
  } else if (family === "mul" && (work.a ?? 0) >= 10) {
    regroups = mulCarries(work.a ?? 0, work.b ?? 0);
  } else if (family === "frac_add" || family === "frac_sub") {
    const d = work.d ?? 0;
    const d1 = work.d1 ?? d;
    const d2 = work.d2 ?? d;
    likeDenominators = d1 > 0 && d1 === d2;
    relation = likeDenominators ? "like" : denomRelation(d1, d2);
    if (family === "frac_add" && likeDenominators) {
      const sum = (work.n1 ?? 0) + (work.n2 ?? 0);
      regroups = sum < d1 ? 0 : sum === d1 ? 1 : 2;
    }
    if (family === "frac_sub") {
      const num = (work.n1 ?? 0) - (work.n2 ?? 0);
      regroups = num > 0 && gcd(num, d1) > 1 ? 1 : 0;
    }
  } else if (family === "frac_compare") {
    likeDenominators = false;
    relation = "unit";
  } else if (family === "frac_equiv" || family === "frac_form") {
    likeDenominators = null;
    relation = "na";
  }
  return {
    digits,
    regroups,
    borrows,
    span,
    blank: template.spec.blank,
    likeDenominators,
    denomRelation: relation,
  };
}

function fractionText(n: number, d: number): string {
  const value = reduce(n, d);
  if (!value) return "";
  return formatRational(value);
}

/** Hand-checked formulas. The test oracle repeats these independently. */
export function computeAnswer(answerOp: string, work: Work): string | null {
  switch (answerOp) {
    case "add":
    case "add_gap":
    case "add_gap_left":
      if (answerOp === "add") return String((work.a ?? 0) + (work.b ?? 0));
      if (answerOp === "add_gap") return String((work.sum ?? 0) - (work.a ?? 0));
      return String((work.sum ?? 0) - (work.b ?? 0));
    case "sub":
      if ((work.a ?? 0) <= (work.b ?? 0)) return null;
      return String(work.a - work.b);
    case "sub_gap":
      if ((work.a ?? 0) <= (work.diff ?? 0)) return null;
      return String(work.a - work.diff);
    case "mul":
      return String((work.a ?? 0) * (work.b ?? 0));
    case "mul_gap":
      if (!work.a || work.product % work.a !== 0) return null;
      return String(work.product / work.a);
    case "mul_gap_left":
      if (!work.b || work.product % work.b !== 0) return null;
      return String(work.product / work.b);
    case "div":
      if (!work.b || work.a % work.b !== 0) return null;
      return String(work.a / work.b);
    case "div_gap":
      if (!work.q || work.a % work.q !== 0) return null;
      return String(work.a / work.q);
    case "div_gap_left":
      return String((work.b ?? 0) * (work.q ?? 0));
    case "frac_add_like": {
      const n1 = work.n1 ?? 0;
      const n2 = work.n2 ?? 0;
      const d = work.d ?? 0;
      if (d <= 0 || n1 <= 0 || n2 <= 0) return null;
      return fractionText(n1 + n2, d);
    }
    case "frac_add_gap": {
      const n2 = (work.sumN ?? 0) - (work.n1 ?? 0);
      if (n2 <= 0) return null;
      return String(n2);
    }
    case "frac_add_unlike": {
      const d1 = work.d1 ?? 0;
      const d2 = work.d2 ?? 0;
      if (d1 <= 0 || d2 <= 0) return null;
      return fractionText((work.n1 ?? 0) * d2 + (work.n2 ?? 0) * d1, d1 * d2);
    }
    case "frac_sub_like": {
      const d = work.d ?? 0;
      const num = (work.n1 ?? 0) - (work.n2 ?? 0);
      if (d <= 0 || num <= 0) return null;
      return fractionText(num, d);
    }
    case "larger_unit": {
      const d1 = work.d1 ?? 0;
      const d2 = work.d2 ?? 0;
      if (d1 <= 1 || d2 <= 1 || d1 === d2) return null;
      return `1/${Math.min(d1, d2)}`;
    }
    case "smaller_unit": {
      const d1 = work.d1 ?? 0;
      const d2 = work.d2 ?? 0;
      if (d1 <= 1 || d2 <= 1 || d1 === d2) return null;
      return `1/${Math.max(d1, d2)}`;
    }
    case "symbol_gt": {
      const d1 = work.d1 ?? 0;
      const d2 = work.d2 ?? 0;
      if (d1 <= 1 || d2 <= 1 || d1 === d2) return null;
      return d1 < d2 ? ">" : "<";
    }
    case "quot":
      return (work.q ?? 0) > 0 ? String(work.q) : null;
    case "divisor":
      return (work.b ?? 0) > 0 ? String(work.b) : null;
    case "dividend":
      return (work.a ?? 0) > 0 ? String(work.a) : null;
    case "blank_b":
      return (work.b ?? 0) > 0 ? String(work.b) : null;
    case "blank_a":
      return (work.a ?? 0) > 0 ? String(work.a) : null;
    case "scale_num":
      return String((work.n ?? 0) * (work.k ?? 0));
    case "scale_exact": {
      const n = (work.n ?? 0) * (work.k ?? 0);
      const d = (work.d ?? 0) * (work.k ?? 0);
      if (d <= 0) return null;
      return `${n}/${d}`;
    }
    case "lowest": {
      if ((work.d ?? 0) <= 0 || gcd(work.n ?? 0, work.d ?? 0) <= 1) return null;
      return fractionText(work.n ?? 0, work.d ?? 0);
    }
    case "to_improper": {
      const whole = work.whole ?? 0;
      const n = work.n ?? 0;
      const d = work.d ?? 0;
      if (whole < 1 || d <= 1 || n <= 0 || n >= d) return null;
      return `${whole * d + n}/${d}`;
    }
    case "to_mixed": {
      const n = work.n ?? 0;
      const d = work.d ?? 0;
      if (d <= 1 || n <= d || n % d === 0) return null;
      const whole = Math.floor(n / d);
      const rem = n % d;
      return `${whole} ${rem}/${d}`;
    }
    default:
      return null;
  }
}

function bugValue(op: string, work: Work): string | null {
  const a = work.a ?? 0;
  const b = work.b ?? 0;
  switch (op) {
    case "add_forget_carry": {
      if (addRegroups(a, b) < 1) return null;
      let place = 1;
      let result = 0;
      let left = a;
      let right = b;
      while (left > 0 || right > 0) {
        const sum = (left % 10) + (right % 10);
        result += (sum % 10) * place;
        left = Math.floor(left / 10);
        right = Math.floor(right / 10);
        place *= 10;
      }
      return String(result);
    }
    case "add_concat_ones": {
      const ones = (a % 10) + (b % 10);
      if (ones < 10) return null;
      const tens = Math.floor(a / 10) + Math.floor(b / 10);
      return String(tens * 100 + ones);
    }
    case "sub_smaller_digit": {
      if (a <= b) return null;
      let place = 1;
      let result = 0;
      let left = a;
      let right = b;
      let any = false;
      while (left > 0 || right > 0) {
        const diff = Math.abs((left % 10) - (right % 10));
        if ((left % 10) !== (right % 10)) any = true;
        result += diff * place;
        left = Math.floor(left / 10);
        right = Math.floor(right / 10);
        place *= 10;
      }
      return any ? String(result) : null;
    }
    case "sub_tens_gap": {
      if (a <= b || a % 10 === b % 10) return null;
      const tens = Math.abs(Math.floor(a / 10) - Math.floor(b / 10));
      return String(tens * 10);
    }
    case "mul_as_add":
      return a > 0 && b > 0 ? String(a + b) : null;
    case "mul_concat":
      if (a >= 10 || b >= 10) return null;
      return String(a * 10 + b);
    case "mul_forget_carry": {
      if (a < 10 || mulCarries(a, b) < 1) return null;
      const ones = (a % 10) * b;
      const tens = Math.floor(a / 10) * b;
      return String(tens * 10 + (ones % 10));
    }
    case "mul_partial": {
      if (a < 10) return null;
      return String(Math.floor(a / 10) * 10 + (a % 10) * b);
    }
    case "div_as_sub":
      return a > b ? String(a - b) : null;
    case "div_as_divisor":
      return b > 0 ? String(b) : null;
    case "div_as_quotient":
      return (work.q ?? 0) > 0 ? String(work.q) : null;
    case "frac_add_parts": {
      const n1 = work.n1 ?? 0;
      const n2 = work.n2 ?? 0;
      const d1 = work.d1 ?? work.d ?? 0;
      const d2 = work.d2 ?? work.d ?? 0;
      if (d1 + d2 <= 0) return null;
      return fractionText(n1 + n2, d1 + d2);
    }
    case "frac_add_nums": {
      const n1 = work.n1 ?? 0;
      const n2 = work.n2 ?? 0;
      return String(n1 + n2);
    }
    case "frac_sub_parts": {
      const num = (work.n1 ?? 0) - (work.n2 ?? 0);
      const den = (work.d ?? 0) + (work.d ?? 0);
      if (num <= 0 || den <= 0) return null;
      return fractionText(num, den);
    }
    case "frac_sub_nums": {
      const num = (work.n1 ?? 0) - (work.n2 ?? 0);
      return num > 0 ? String(num) : null;
    }
    case "unit_larger_den": {
      const d1 = work.d1 ?? 0;
      const d2 = work.d2 ?? 0;
      if (d1 === d2) return null;
      return `1/${Math.max(d1, d2)}`;
    }
    case "unit_smaller_den": {
      const d1 = work.d1 ?? 0;
      const d2 = work.d2 ?? 0;
      if (d1 === d2) return null;
      return `1/${Math.min(d1, d2)}`;
    }
    case "scale_reduce": {
      const d = work.d ?? 0;
      const n = work.n ?? 0;
      if (d <= 0) return null;
      return fractionText(n, d);
    }
    case "unit_sum_den": {
      const d1 = work.d1 ?? 0;
      const d2 = work.d2 ?? 0;
      return `1/${d1 + d2}`;
    }
    case "scale_add":
      return String((work.n ?? 0) + (work.k ?? 0));
    case "scale_both":
      return String((work.n ?? 0) * (work.k ?? 0) * (work.d ?? 1));
    case "lowest_minus": {
      const n = (work.n ?? 0) - 1;
      const d = (work.d ?? 0) - 1;
      if (n <= 0 || d <= 0) return null;
      return `${n}/${d}`;
    }
    case "lowest_num_only": {
      const g = gcd(work.n ?? 0, work.d ?? 0);
      if (g <= 1) return null;
      return `${(work.n ?? 0) / g}/${work.d ?? 0}`;
    }
    case "form_add": {
      if (work.whole !== undefined) {
        return `${(work.whole ?? 0) + (work.n ?? 0)}/${work.d ?? 1}`;
      }
      return `${(work.n ?? 0) + (work.d ?? 0)}/${work.d ?? 1}`;
    }
    case "form_swap": {
      if (work.whole !== undefined) return `${work.n ?? 0} ${work.whole ?? 0}/${work.d ?? 1}`;
      const d = work.d ?? 1;
      const n = work.n ?? 0;
      if (n <= d) return null;
      return `${n % d} ${Math.floor(n / d)}/${d}`;
    }
    default:
      return null;
  }
}

function sameWrong(mode: "rational" | "exact", left: string, right: string): boolean {
  if (mode === "exact") {
    return left.replace(/\s+/g, "") === right.replace(/\s+/g, "");
  }
  return canonicalValueKey(left) === canonicalValueKey(right);
}

export function ambiguousBugs(mode: "rational" | "exact", answer: string, bugs: BugHit[]): boolean {
  if (bugs.some((bug) => sameWrong(mode, bug.wrong, answer))) return true;
  for (let i = 0; i < bugs.length; i += 1) {
    for (let j = i + 1; j < bugs.length; j += 1) {
      const left = bugs[i];
      const right = bugs[j];
      if (left && right && sameWrong(mode, left.wrong, right.wrong)) return true;
    }
  }
  return false;
}

function activeBugs(template: TemplateVersion, work: Work, answer: string): BugHit[] {
  const hits: BugHit[] = [];
  for (const rule of template.bugRules) {
    if (rule.when && !constraintHolds(rule.when, template.spec.answerOp, work)) continue;
    const wrong = bugValue(rule.op, work);
    if (!wrong) continue;
    hits.push({ id: rule.id, cueKey: rule.cueKey, wrong });
  }
  return hits.filter((hit) => hit.wrong.length > 0);
}

/** A reduced denominator of 1 is a whole number, including 4/4. */
export function isWholeCanonical(answer: string): boolean {
  const parsed = parseAnswer(answer);
  return parsed.kind === "rational" && parsed.value.d === 1;
}

/** Value strictly below 1. Whole numbers and improper values are not proper. */
export function isProperFraction(answer: string): boolean {
  const parsed = parseAnswer(answer);
  return parsed.kind === "rational" && parsed.value.n > 0 && parsed.value.n < parsed.value.d;
}

/**
 * Mixed form of a whole number is just that number, so requiring mixed
 * would mark a correct `1` wrong. Those operand sets are not drawable.
 */
export function canonicalAllowedForForm(
  requireForm: RequireForm | null,
  canonical: string,
): boolean {
  if (requireForm !== "mixed") return true;
  return !isWholeCanonical(canonical);
}

function slotProduct(slots: Record<string, { min: number; max: number }>): Work[] {
  let combos: Work[] = [{}];
  for (const [name, slot] of Object.entries(slots)) {
    const next: Work[] = [];
    for (const combo of combos) {
      for (let value = slot.min; value <= slot.max; value += 1) {
        next.push({ ...combo, [name]: value });
      }
    }
    combos = next;
  }
  return combos;
}

function realizeDraw(template: TemplateVersion, step: 1 | 2 | 3, drawn: Work): Draw | null {
  const variant = template.spec.steps.find((item) => item.assignedStep === step);
  if (!variant) return null;
  const work = deriveWork(template.spec.answerOp, drawn);
  if (!work) return null;
  for (const constraint of variant.constraints) {
    if (!constraintHolds(constraint, template.spec.answerOp, work, drawn)) return null;
  }
  const canonicalAnswer = computeAnswer(template.spec.answerOp, work);
  if (!canonicalAnswer) return null;
  if (!canonicalAllowedForForm(template.requireForm ?? null, canonicalAnswer)) return null;
  if (
    template.requireForm === "lowest_terms" &&
    step === 1 &&
    !isProperFraction(canonicalAnswer)
  ) {
    return null;
  }
  const values = strMap(work, canonicalAnswer);
  const bugs = activeBugs(template, work, canonicalAnswer);
  const features = measureFeatures(template, drawn, work);
  return {
    operands: drawn,
    work,
    canonicalAnswer,
    answerLine: fill(template.spec.prompt.answerLine, values),
    prompt: fill(template.spec.prompt.stem, values),
    leading: fill(template.spec.prompt.leading, values),
    trailing: fill(template.spec.prompt.trailing, values),
    column: template.spec.prompt.column.map((line) => fill(line, values)),
    bugs,
    features,
    ambiguous: ambiguousBugs(template.spec.compare, canonicalAnswer, bugs),
  };
}

export function drawOnce(template: TemplateVersion, step: 1 | 2 | 3, rng: Rng): Draw | null {
  const variant = template.spec.steps.find((item) => item.assignedStep === step);
  if (!variant) return null;
  const drawn: Work = {};
  for (const [name, slot] of Object.entries(variant.slots)) {
    drawn[name] = drawInt(rng, slot.min, slot.max);
  }
  return realizeDraw(template, step, drawn);
}

/** Every operand set drawAccepted can return, after the mixed-form filter. */
export function eligibleDraws(template: TemplateVersion, step: 1 | 2 | 3): Draw[] {
  const variant = template.spec.steps.find((item) => item.assignedStep === step);
  if (!variant) return [];
  const draws: Draw[] = [];
  for (const drawn of slotProduct(variant.slots)) {
    const draw = realizeDraw(template, step, drawn);
    if (!draw || draw.ambiguous) continue;
    if (!featuresMatch(draw.features, variant.features)) continue;
    draws.push(draw);
  }
  return draws;
}

export function drawAccepted(
  template: TemplateVersion,
  step: 1 | 2 | 3,
  rng: Rng,
  attempts = 80,
): Draw | null {
  for (let index = 0; index < attempts; index += 1) {
    const draw = drawOnce(template, step, rng);
    if (!draw || draw.ambiguous) continue;
    const variant = template.spec.steps.find((item) => item.assignedStep === step);
    if (!variant || !featuresMatch(draw.features, variant.features)) continue;
    return draw;
  }
  return null;
}

export function focusFromHits(template: TemplateVersion, hits: BugHit[], given: string): string {
  for (const hit of hits) {
    if (!sameWrong(template.spec.compare, hit.wrong, given)) continue;
    const text = cueText(hit.cueKey);
    if (text) return text;
  }
  return cueText(template.defaultFocus);
}

export type ValidationFlag = { step: number; message: string };

export type ValidationReport = {
  rejected: boolean;
  reasons: string[];
  flags: ValidationFlag[];
  computedByStep: Partial<Record<1 | 2 | 3, 1 | 2 | 3>>;
};

function isAllowed(value: string, allow: readonly string[]): boolean {
  return allow.includes(value);
}

export function validateTemplate(template: TemplateVersion, rng: Rng = seeded(1)): ValidationReport {
  const reasons: string[] = [];
  const flags: ValidationFlag[] = [];
  const computedByStep: Partial<Record<1 | 2 | 3, 1 | 2 | 3>> = {};
  if (!isAllowed(template.spec.answerOp, ANSWER_OPS)) {
    reasons.push(`disallowed answer op ${template.spec.answerOp}`);
  }
  for (const rule of template.bugRules) {
    if (!isAllowed(rule.op, BUG_OPS)) reasons.push(`disallowed bug op ${rule.op}`);
  }
  if (reasons.length > 0) {
    return { rejected: true, reasons, flags, computedByStep };
  }
  for (const variant of template.spec.steps) {
    const step = variant.assignedStep;
    let saw = false;
    for (let sample = 0; sample < 4; sample += 1) {
      let draw: Draw | null = null;
      for (let attempt = 0; attempt < 40 && !draw; attempt += 1) {
        const candidate = drawOnce(template, step, rng);
        if (candidate) draw = candidate;
      }
      if (!draw) continue;
      saw = true;
      const matches = template.spec.steps.filter((item) => featuresMatch(draw.features, item.features));
      if (matches.length === 0) {
        reasons.push(`step ${step} features fall outside every step range`);
        continue;
      }
      const computed = matches.length === 1 ? matches[0]?.assignedStep : undefined;
      if (computed === undefined) {
        flags.push({ step, message: `step ${step} features match more than one step` });
        continue;
      }
      computedByStep[step] = computed;
      if (computed !== step) {
        flags.push({
          step,
          message: `computed step ${computed} does not match assigned step ${step}`,
        });
      }
    }
    if (!saw) reasons.push(`step ${step} produced no draw`);
    if (template.requireForm === "mixed") {
      const accepted = eligibleDraws(template, step);
      if (accepted.some((draw) => isWholeCanonical(draw.canonicalAnswer))) {
        reasons.push(`step ${step} mixed form includes a whole answer`);
      }
    }
    if (template.requireForm === "lowest_terms" && step === 1) {
      const accepted = eligibleDraws(template, step);
      if (accepted.some((draw) => !isProperFraction(draw.canonicalAnswer))) {
        reasons.push(`step ${step} lowest terms includes a value that is not a proper fraction`);
      }
    }
  }
  return { rejected: reasons.length > 0, reasons, flags, computedByStep };
}

export function seeded(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function requireFormOf(template: TemplateVersion): RequireForm | null {
  return template.requireForm ?? null;
}
