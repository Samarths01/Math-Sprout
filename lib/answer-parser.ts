/**
 * The one answer parser. Client-safe: this file imports nothing.
 * The server decides what a parsed answer means. Callers share this function.
 */

export type Rational = { n: number; d: number };

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

export function formatRational(value: Rational): string {
  return rationalKey(value);
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

/** Form of a stored canonical answer. This is not the child's text. */
export function expectedAnswerType(
  canonical: string,
): "integer" | "fraction" | "mixed" | "symbol" | "unparsed" {
  const parsed = parseAnswer(canonical);
  if (parsed.kind === "symbol") return "symbol";
  if (parsed.kind === "rational") {
    if (parsed.form === "mixed") return "mixed";
    if (parsed.form === "integer") return "integer";
    return "fraction";
  }
  return "unparsed";
}
