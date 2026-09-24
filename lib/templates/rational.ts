/**
 * Fraction answers are compared as reduced rationals.
 * Mixed numbers and improper fractions share a value unless a template
 * requires one written form.
 */

export type Rational = { n: number; d: number };

export type RequireForm = "lowest_terms" | "mixed" | "improper";

export type ParsedAnswer =
  | { kind: "blank" }
  | { kind: "unparseable" }
  | { kind: "symbol"; symbol: ">" | "<" }
  | {
      kind: "rational";
      value: Rational;
      /** How the kid wrote it, after space cleanup. */
      written: string;
      form: "integer" | "lowest_terms" | "unreduced" | "improper" | "mixed";
    };

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

export function reduce(n: number, d: number): Rational | null {
  if (!Number.isInteger(n) || !Number.isInteger(d) || d === 0) return null;
  const sign = n < 0 ? -1 : 1;
  const g = gcd(n, d);
  return { n: (sign * Math.abs(n)) / g, d: Math.abs(d) / g };
}

export function rationalsEqual(left: Rational, right: Rational): boolean {
  return left.n === right.n && left.d === right.d;
}

/** Canonical value key. Equivalent writings share a key. */
export function rationalKey(value: Rational): string {
  return value.d === 1 ? String(value.n) : `${value.n}/${value.d}`;
}

function cleanup(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export function parseAnswer(raw: string): ParsedAnswer {
  if (raw.trim().length === 0) return { kind: "blank" };
  const written = cleanup(raw);
  if (written === ">" || written === "<") return { kind: "symbol", symbol: written };
  if (/^-?\d+$/.test(written)) {
    const n = Number(written);
    const value = reduce(n, 1);
    if (!value) return { kind: "unparseable" };
    return { kind: "rational", value, written, form: "integer" };
  }
  const mixed = written.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const num = Number(mixed[2]);
    const den = Number(mixed[3]);
    if (den <= 0 || num <= 0 || num >= den || whole < 1) return { kind: "unparseable" };
    const value = reduce(whole * den + num, den);
    if (!value) return { kind: "unparseable" };
    return {
      kind: "rational",
      value,
      written: `${whole} ${num}/${den}`,
      form: "mixed",
    };
  }
  const fraction = written.match(/^(-?\d+)\s*\/\s*(\d+)$/);
  if (!fraction) return { kind: "unparseable" };
  const num = Number(fraction[1]);
  const den = Number(fraction[2]);
  if (den <= 0) return { kind: "unparseable" };
  const value = reduce(num, den);
  if (!value) return { kind: "unparseable" };
  const reduced = gcd(num, den) === 1;
  const improper = Math.abs(num) >= den && den !== 1;
  let form: "lowest_terms" | "unreduced" | "improper" = "unreduced";
  if (improper && !reduced) form = "improper";
  else if (improper && reduced) form = "improper";
  else if (reduced) form = "lowest_terms";
  return {
    kind: "rational",
    value,
    written: `${num}/${den}`,
    form: den === 1 ? "integer" : form,
  };
}

export function formatRational(value: Rational): string {
  return rationalKey(value);
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
): "blank" | "unparseable" | "correct" | "incorrect" {
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
  if (requireForm === "mixed") return got.form === "mixed" ? "correct" : "incorrect";
  if (requireForm === "improper") {
    return got.form === "improper" ? "correct" : "incorrect";
  }
  const reducedWrite =
    got.form === "lowest_terms" || got.form === "integer" || (got.form === "improper" && gcdFromWritten(got.written));
  return reducedWrite ? "correct" : "incorrect";
}

function gcdFromWritten(written: string): boolean {
  const fraction = written.match(/^(-?\d+)\/(\d+)$/);
  if (!fraction) return written.match(/^-?\d+$/) !== null;
  return gcd(Number(fraction[1]), Number(fraction[2])) === 1;
}

/** Collision key for operands plus the answer value. */
export function canonicalValueKey(answer: string): string {
  const parsed = parseAnswer(answer);
  if (parsed.kind === "rational") return rationalKey(parsed.value);
  if (parsed.kind === "symbol") return parsed.symbol;
  return cleanup(answer);
}
