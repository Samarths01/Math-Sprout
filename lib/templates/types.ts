import type { RequireForm } from "@/lib/templates/rational";

export const ANSWER_OPS = [
  "add",
  "add_gap",
  "add_gap_left",
  "sub",
  "sub_gap",
  "mul",
  "mul_gap",
  "mul_gap_left",
  "div",
  "div_gap",
  "div_gap_left",
  "frac_add_like",
  "frac_add_gap",
  "frac_add_unlike",
  "frac_sub_like",
  "larger_unit",
  "smaller_unit",
  "symbol_gt",
  "scale_num",
  "scale_exact",
  "quot",
  "divisor",
  "dividend",
  "blank_b",
  "blank_a",
  "lowest",
  "to_improper",
  "to_mixed",
] as const;

export const BUG_OPS = [
  "add_forget_carry",
  "add_concat_ones",
  "sub_smaller_digit",
  "sub_tens_gap",
  "mul_as_add",
  "mul_concat",
  "mul_forget_carry",
  "mul_partial",
  "div_as_sub",
  "div_as_divisor",
  "div_as_quotient",
  "frac_add_parts",
  "frac_add_nums",
  "frac_sub_parts",
  "frac_sub_nums",
  "unit_larger_den",
  "unit_smaller_den",
  "unit_sum_den",
  "scale_reduce",
  "scale_add",
  "scale_both",
  "lowest_minus",
  "lowest_num_only",
  "form_add",
  "form_swap",
] as const;

export const FAMILIES = [
  "add",
  "sub",
  "mul",
  "div",
  "frac_add",
  "frac_sub",
  "frac_compare",
  "frac_equiv",
  "frac_form",
] as const;

export type AnswerOp = (typeof ANSWER_OPS)[number];
export type BugOp = (typeof BUG_OPS)[number];
export type Family = (typeof FAMILIES)[number];
export type CompareMode = "rational" | "exact";
export type ParentPriorDifficulty = "easy" | "medium" | "hard";
export type Layout = "inline" | "column";

export type SlotRange = { min: number; max: number };

export type Constraint =
  | { op: "add_regroups_eq"; value: number }
  | { op: "add_regroups_gte"; value: number }
  | { op: "sub_borrows_eq"; value: number }
  | { op: "sub_borrows_gte"; value: number }
  | { op: "mul_carries_eq"; value: number }
  | { op: "mul_carries_gte"; value: number }
  | { op: "gt_left" }
  | { op: "div_exact" }
  | { op: "product_le"; value: number }
  | { op: "product_ge"; value: number }
  | { op: "sum_lt_den" }
  | { op: "sum_eq_den" }
  | { op: "sum_gt_den" }
  | { op: "diff_positive" }
  | { op: "result_reduces" }
  | { op: "result_lowest" }
  | { op: "span_between"; min: number; max: number }
  | { op: "den_multiple" }
  | { op: "den_unlike" }
  | { op: "like_den" }
  | { op: "gcd_gt_one" }
  | { op: "proper_part" }
  | { op: "improper_source" }
  | { op: "ones_sum_gte"; value: number }
  | { op: "factors_below"; value: number };

export type FeatureRange = {
  digits: [number, number];
  regroups: [number, number];
  borrows: [number, number];
  span: [number, number];
  blank: string;
  likeDenominators: boolean | null;
  denomRelation: "like" | "multiple" | "unlike" | "unit" | "na" | null;
};

export type StepVariant = {
  assignedStep: 1 | 2 | 3;
  /** Hand-assigned from the feature check. Seeds keep this equal to assignedStep. */
  computedStep: 1 | 2 | 3;
  slots: Record<string, SlotRange>;
  constraints: Constraint[];
  features: FeatureRange;
};

export type PromptSpec = {
  stem: string;
  leading: string;
  trailing: string;
  answerLine: string;
  column: string[];
};

export type TemplateSpec = {
  family: string;
  answerOp: string;
  compare: CompareMode;
  layout: Layout;
  blank: string;
  /** Legacy v0 rows. They do not count toward the generated-template bar. */
  legacy: boolean;
  steps: StepVariant[];
  prompt: PromptSpec;
};

export type BugRule = {
  id: string;
  op: string;
  cueKey: string;
  when?: Constraint;
};

export type TemplateVersion = {
  templateId: string;
  version: number;
  skillId: string;
  promptShape: string;
  spec: TemplateSpec;
  bugRules: BugRule[];
  defaultFocus?: string;
  whyItWorks?: string;
  requireForm?: RequireForm;
  provenance: "seed" | "parent" | "ai_assisted";
  evidenceEligible: boolean;
  parentPriorGrade: number | null;
  parentPriorDifficulty: ParentPriorDifficulty | null;
  active: boolean;
  promoted: boolean;
};

export type MeasuredFeatures = {
  digits: number;
  regroups: number;
  borrows: number;
  span: number;
  blank: string;
  likeDenominators: boolean | null;
  denomRelation: "like" | "multiple" | "unlike" | "unit" | "na";
};

export type BugHit = {
  id: string;
  cueKey: string;
  wrong: string;
};

export type Draw = {
  operands: Record<string, number>;
  work: Record<string, number>;
  canonicalAnswer: string;
  answerLine: string;
  prompt: string;
  leading: string;
  trailing: string;
  column: string[];
  bugs: BugHit[];
  features: MeasuredFeatures;
  ambiguous: boolean;
};
