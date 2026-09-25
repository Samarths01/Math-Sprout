import { parseAnswer } from "@/lib/answer-parser";
import type { RequireForm } from "@/lib/templates/rational";

/**
 * Architecture §29. Child copy for a right amount in the wrong written form.
 * The attempt row still stores `form_mismatch`. That tag is not this module.
 */
export const WRONG_FORM_KIND = "wrong_form" as const;

export type WrongFormRequired = RequireForm;

export type WrongFormReason = {
  kind: typeof WRONG_FORM_KIND;
  required: WrongFormRequired;
};

/** What you tried. Body ink. It does not restate the form rule. */
export const WRONG_FORM_WHAT_YOU_TRIED = "You wrote {typed}. That's the right amount!";

export const WRONG_FORM_ONE_FOCUS: Record<WrongFormRequired, string> = {
  lowest_terms: "This one asks for lowest terms, so it's {canonical}.",
  improper: "This one asks for one fraction with no whole number in front, so it's {canonical}.",
  mixed: "This one asks for the whole number first, then the fraction, so it's {canonical}.",
};

/** Lock in for wrong_form only. */
export const WRONG_FORM_LOCK_IN = "{typed} = {canonical}";

export function normalizedTypedAnswer(raw: string): string {
  const parsed = parseAnswer(raw);
  if (parsed.kind === "rational") return parsed.written;
  return raw.trim().replace(/\s+/g, " ");
}

function fill(template: string, values: { typed: string; canonical: string }): string {
  return template.replaceAll("{typed}", values.typed).replaceAll("{canonical}", values.canonical);
}

export function wrongFormCopy(input: {
  typed: string;
  canonical: string;
  required: WrongFormRequired;
}): {
  whatWentWell: string;
  oneFocus: string;
  tryNext: string;
  lockIn: string;
  reason: WrongFormReason;
} {
  const values = { typed: input.typed, canonical: input.canonical };
  return {
    whatWentWell: fill(WRONG_FORM_WHAT_YOU_TRIED, values),
    oneFocus: fill(WRONG_FORM_ONE_FOCUS[input.required], values),
    tryNext: "",
    lockIn: fill(WRONG_FORM_LOCK_IN, values),
    reason: { kind: WRONG_FORM_KIND, required: input.required },
  };
}

function isWrongFormRequired(value: string | null): value is WrongFormRequired {
  return value === "lowest_terms" || value === "improper" || value === "mixed";
}

/**
 * Built when a stored answer is read back. `beats_json` keeps the four beat
 * strings only. A blank, unreadable, or flagged try has no reason.
 */
export function wrongFormReasonFor(input: {
  flags: readonly string[];
  formMismatch: boolean;
  required: string | null;
}): WrongFormReason | undefined {
  if (input.flags.length > 0 || !input.formMismatch || !isWrongFormRequired(input.required)) {
    return undefined;
  }
  return { kind: WRONG_FORM_KIND, required: input.required };
}
