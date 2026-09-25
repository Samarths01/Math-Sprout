import type {
  BugRule,
  Constraint,
  FeatureRange,
  PromptSpec,
  StepVariant,
  TemplateSpec,
  TemplateVersion,
} from "@/lib/templates/types";

export const SKILLS = {
  add: "adding two-digit numbers",
  sub: "subtracting two-digit numbers",
  mul: "multiplying within 100",
  div: "dividing within 100",
  mul2: "multiplying a two-digit number by one digit",
  div2: "dividing a two-digit number",
  compare: "comparing unit fractions",
  equiv: "finding an equivalent fraction",
  addLike: "adding fractions with the same denominator",
  addUnlike: "adding fractions with different denominators",
  subLike: "subtracting fractions with the same denominator",
} as const;

const ADD_WHY = "Add the ones first. 7 + 5 is 12, so write 2 and carry 1 ten.";

function slots(entries: Record<string, [number, number]>): StepVariant["slots"] {
  const out: StepVariant["slots"] = {};
  for (const [name, range] of Object.entries(entries)) {
    out[name] = { min: range[0], max: range[1] };
  }
  return out;
}

function feat(
  blank: string,
  patch: Partial<FeatureRange> = {},
): FeatureRange {
  return {
    digits: [1, 4],
    regroups: [0, 4],
    borrows: [0, 4],
    span: [1, 400],
    blank,
    likeDenominators: null,
    denomRelation: null,
    ...patch,
  };
}

function step(
  assignedStep: 1 | 2 | 3,
  slotSpec: Record<string, [number, number]>,
  constraints: Constraint[],
  features: FeatureRange,
): StepVariant {
  return {
    assignedStep,
    computedStep: assignedStep,
    slots: slots(slotSpec),
    constraints,
    features,
  };
}

function prompt(
  stem: string,
  answerLine: string,
  leading = "",
  trailing = "",
  column: string[] = [],
): PromptSpec {
  return { stem, leading, trailing, answerLine, column };
}

function spec(input: TemplateSpec): TemplateSpec {
  return input;
}

function template(
  input: Pick<
    TemplateVersion,
    "templateId" | "version" | "skillId" | "promptShape" | "spec" | "bugRules"
  > &
    Partial<Pick<TemplateVersion, "defaultFocus" | "whyItWorks" | "requireForm">>,
): TemplateVersion {
  return {
    ...input,
    provenance: "seed",
    evidenceEligible: true,
    parentPriorGrade: null,
    parentPriorDifficulty: null,
    active: true,
    promoted: true,
  };
}

const addBugs: BugRule[] = [
  {
    id: "forget-carry",
    op: "add_forget_carry",
    cueKey: "add.carry",
    when: { op: "add_regroups_gte", value: 1 },
  },
  {
    id: "concat-ones",
    op: "add_concat_ones",
    cueKey: "add.place",
    when: { op: "ones_sum_gte", value: 10 },
  },
];

const subBugs: BugRule[] = [
  {
    id: "smaller-digit",
    op: "sub_smaller_digit",
    cueKey: "sub.borrow",
    when: { op: "sub_borrows_gte", value: 1 },
  },
  {
    id: "tens-gap",
    op: "sub_tens_gap",
    cueKey: "sub.order",
    when: { op: "sub_borrows_gte", value: 1 },
  },
];

const mulBugs: BugRule[] = [
  { id: "mul-add", op: "mul_as_add", cueKey: "mul.product" },
  { id: "mul-concat", op: "mul_concat", cueKey: "mul.place", when: { op: "factors_below", value: 10 } },
];

const mul2Bugs: BugRule[] = [
  { id: "mul-add", op: "mul_as_add", cueKey: "mul.product" },
  {
    id: "mul-forget",
    op: "mul_forget_carry",
    cueKey: "mul.place",
    when: { op: "mul_carries_gte", value: 1 },
  },
];

const divBugs: BugRule[] = [
  { id: "div-sub", op: "div_as_sub", cueKey: "div.groups" },
  { id: "div-divisor", op: "div_as_divisor", cueKey: "div.split" },
];

const divisorBugs: BugRule[] = [
  { id: "div-sub", op: "div_as_sub", cueKey: "div.groups" },
  { id: "div-quot", op: "div_as_quotient", cueKey: "div.split" },
];

const likeAddBugs: BugRule[] = [
  { id: "add-parts", op: "frac_add_parts", cueKey: "frac.like" },
  { id: "add-nums", op: "frac_add_nums", cueKey: "frac.unlike" },
];

const unlikeBugs: BugRule[] = [
  { id: "add-parts", op: "frac_add_parts", cueKey: "frac.unlike" },
  { id: "add-nums", op: "frac_add_nums", cueKey: "frac.like" },
];

const subFracBugs: BugRule[] = [
  { id: "sub-parts", op: "frac_sub_parts", cueKey: "frac.sub" },
  { id: "sub-nums", op: "frac_sub_nums", cueKey: "frac.like" },
];

const largerBugs: BugRule[] = [
  { id: "larger-den", op: "unit_larger_den", cueKey: "frac.unit" },
  { id: "sum-den", op: "unit_sum_den", cueKey: "frac.equiv" },
];

const smallerBugs: BugRule[] = [
  { id: "smaller-den", op: "unit_smaller_den", cueKey: "frac.unit" },
  { id: "sum-den", op: "unit_sum_den", cueKey: "frac.equiv" },
];

function legacyWide(blank: string): FeatureRange {
  return feat(blank);
}

const SEEDED_TEMPLATES: TemplateVersion[] = [
  template({
    templateId: "add-2d-v0",
    version: 0,
    skillId: SKILLS.add,
    promptShape: "legacy_stem",
    defaultFocus: "add.carry",
    whyItWorks: ADD_WHY,
    bugRules: addBugs,
    spec: spec({
      family: "add",
      answerOp: "add",
      compare: "exact",
      layout: "inline",
      blank: "result",
      legacy: true,
      prompt: prompt("What is {a} + {b}?", "{a} + {b} = {answer}"),
      steps: [step(1, { a: [27, 27], b: [15, 15] }, [], legacyWide("result"))],
    }),
  }),
  template({
    templateId: "add-2d-inline",
    version: 1,
    skillId: SKILLS.add,
    promptShape: "inline_result",
    defaultFocus: "add.carry",
    bugRules: addBugs,
    spec: spec({
      family: "add",
      answerOp: "add",
      compare: "exact",
      layout: "inline",
      blank: "result",
      legacy: false,
      prompt: prompt("What is {a} + {b}?", "{a} + {b} = {answer}"),
      steps: [
        step(1, { a: [12, 44], b: [11, 35] }, [{ op: "add_regroups_eq", value: 0 }], feat("result", { regroups: [0, 0], digits: [2, 2] })),
        step(2, { a: [16, 78], b: [14, 69] }, [{ op: "add_regroups_eq", value: 1 }], feat("result", { regroups: [1, 1], digits: [2, 2] })),
        step(3, { a: [55, 89], b: [46, 79] }, [{ op: "add_regroups_eq", value: 2 }], feat("result", { regroups: [2, 2], digits: [2, 2] })),
      ],
    }),
  }),
  template({
    templateId: "add-2d-blank",
    version: 1,
    skillId: SKILLS.add,
    promptShape: "inline_blank_right",
    defaultFocus: "add.carry",
    bugRules: addBugs,
    spec: spec({
      family: "add",
      answerOp: "add_gap",
      compare: "exact",
      layout: "inline",
      blank: "right",
      legacy: false,
      prompt: prompt("{a} + __ = {sum}", "{a} + {answer} = {sum}", "{a} +", "= {sum}"),
      steps: [
        step(1, { a: [12, 40], sum: [28, 70] }, [{ op: "add_regroups_eq", value: 0 }], feat("right", { regroups: [0, 0], digits: [2, 2] })),
        step(2, { a: [16, 60], sum: [40, 99] }, [{ op: "add_regroups_eq", value: 1 }], feat("right", { regroups: [1, 1], digits: [2, 2] })),
        step(3, { a: [56, 59], sum: [112, 114] }, [{ op: "add_regroups_eq", value: 2 }], feat("right", { regroups: [2, 2], digits: [3, 3], span: [112, 114] })),
      ],
    }),
  }),
  template({
    templateId: "add-2d-column",
    version: 1,
    skillId: SKILLS.add,
    promptShape: "column_result",
    defaultFocus: "not.a.real.cue",
    bugRules: addBugs,
    spec: spec({
      family: "add",
      answerOp: "add",
      compare: "exact",
      layout: "column",
      blank: "result",
      legacy: false,
      prompt: prompt("{a} + {b}", "{a} + {b} = {answer}", "", "", ["  {a}", "+ {b}"]),
      steps: [
        step(1, { a: [12, 44], b: [11, 35] }, [{ op: "add_regroups_eq", value: 0 }], feat("result", { regroups: [0, 0], digits: [2, 2] })),
        step(2, { a: [16, 78], b: [14, 69] }, [{ op: "add_regroups_eq", value: 1 }], feat("result", { regroups: [1, 1], digits: [2, 2] })),
        step(3, { a: [55, 89], b: [46, 79] }, [{ op: "add_regroups_eq", value: 2 }], feat("result", { regroups: [2, 2], digits: [2, 2] })),
      ],
    }),
  }),

  template({
    templateId: "sub-2d-v0",
    version: 0,
    skillId: SKILLS.sub,
    promptShape: "legacy_stem",
    defaultFocus: "sub.borrow",
    bugRules: subBugs,
    spec: spec({
      family: "sub",
      answerOp: "sub",
      compare: "exact",
      layout: "inline",
      blank: "result",
      legacy: true,
      prompt: prompt("What is {a} - {b}?", "{a} - {b} = {answer}"),
      steps: [step(1, { a: [63, 63], b: [18, 18] }, [{ op: "gt_left" }], legacyWide("result"))],
    }),
  }),
  template({
    templateId: "sub-2d-inline",
    version: 1,
    skillId: SKILLS.sub,
    promptShape: "inline_result",
    defaultFocus: "sub.borrow",
    bugRules: subBugs,
    spec: spec({
      family: "sub",
      answerOp: "sub",
      compare: "exact",
      layout: "inline",
      blank: "result",
      legacy: false,
      prompt: prompt("What is {a} - {b}?", "{a} - {b} = {answer}"),
      steps: [
        step(1, { a: [42, 79], b: [11, 24] }, [{ op: "sub_borrows_eq", value: 0 }], feat("result", { borrows: [0, 0], digits: [2, 2] })),
        step(2, { a: [22, 50], b: [13, 39] }, [{ op: "sub_borrows_eq", value: 1 }], feat("result", { borrows: [1, 1], span: [1, 55], digits: [2, 2] })),
        step(3, { a: [70, 98], b: [16, 59] }, [{ op: "sub_borrows_eq", value: 1 }], feat("result", { borrows: [1, 1], span: [56, 99], digits: [2, 2] })),
      ],
    }),
  }),
  template({
    templateId: "sub-2d-blank",
    version: 1,
    skillId: SKILLS.sub,
    promptShape: "inline_blank_right",
    defaultFocus: "sub.borrow",
    bugRules: subBugs,
    spec: spec({
      family: "sub",
      answerOp: "sub_gap",
      compare: "exact",
      layout: "inline",
      blank: "right",
      legacy: false,
      prompt: prompt("{a} - __ = {diff}", "{a} - {answer} = {diff}", "{a} -", "= {diff}"),
      steps: [
        step(1, { a: [42, 79], diff: [20, 50] }, [{ op: "sub_borrows_eq", value: 0 }], feat("right", { borrows: [0, 0], digits: [2, 2] })),
        step(2, { a: [31, 54], diff: [8, 30] }, [{ op: "sub_borrows_eq", value: 1 }], feat("right", { borrows: [1, 1], span: [1, 55], digits: [2, 2] })),
        step(3, { a: [72, 98], diff: [10, 40] }, [{ op: "sub_borrows_eq", value: 1 }], feat("right", { borrows: [1, 1], span: [56, 99], digits: [2, 2] })),
      ],
    }),
  }),
  template({
    templateId: "sub-2d-column",
    version: 1,
    skillId: SKILLS.sub,
    promptShape: "column_result",
    bugRules: subBugs,
    spec: spec({
      family: "sub",
      answerOp: "sub",
      compare: "exact",
      layout: "column",
      blank: "result",
      legacy: false,
      prompt: prompt("{a} - {b}", "{a} - {b} = {answer}", "", "", ["  {a}", "- {b}"]),
      steps: [
        step(1, { a: [42, 79], b: [11, 24] }, [{ op: "sub_borrows_eq", value: 0 }], feat("result", { borrows: [0, 0], digits: [2, 2] })),
        step(2, { a: [22, 50], b: [13, 39] }, [{ op: "sub_borrows_eq", value: 1 }], feat("result", { borrows: [1, 1], span: [1, 55], digits: [2, 2] })),
        step(3, { a: [70, 98], b: [16, 59] }, [{ op: "sub_borrows_eq", value: 1 }], feat("result", { borrows: [1, 1], span: [56, 99], digits: [2, 2] })),
      ],
    }),
  }),

  template({
    templateId: "mul-100-v0",
    version: 0,
    skillId: SKILLS.mul,
    promptShape: "legacy_stem",
    defaultFocus: "mul.product",
    bugRules: mulBugs,
    spec: spec({
      family: "mul",
      answerOp: "mul",
      compare: "exact",
      layout: "inline",
      blank: "result",
      legacy: true,
      prompt: prompt("What is {a} × {b}?", "{a} × {b} = {answer}"),
      steps: [step(1, { a: [7, 7], b: [8, 8] }, [], legacyWide("result"))],
    }),
  }),
  template({
    templateId: "mul-100-inline",
    version: 1,
    skillId: SKILLS.mul,
    promptShape: "inline_result",
    defaultFocus: "mul.product",
    bugRules: mulBugs,
    spec: spec({
      family: "mul",
      answerOp: "mul",
      compare: "exact",
      layout: "inline",
      blank: "result",
      legacy: false,
      prompt: prompt("What is {a} × {b}?", "{a} × {b} = {answer}"),
      steps: [
        step(1, { a: [2, 5], b: [2, 5] }, [{ op: "product_le", value: 25 }], feat("result", { span: [2, 5], digits: [1, 1], regroups: [0, 0] })),
        step(2, { a: [6, 9], b: [3, 9] }, [{ op: "product_le", value: 81 }], feat("result", { span: [6, 9], digits: [1, 1], regroups: [0, 0] })),
        step(3, { a: [10, 12], b: [3, 8] }, [{ op: "product_le", value: 100 }], feat("result", { span: [10, 12], digits: [2, 2], regroups: [0, 4] })),
      ],
    }),
  }),
  template({
    templateId: "mul-100-blank",
    version: 1,
    skillId: SKILLS.mul,
    promptShape: "inline_blank_right",
    defaultFocus: "mul.product",
    bugRules: mulBugs,
    spec: spec({
      family: "mul",
      answerOp: "blank_b",
      compare: "exact",
      layout: "inline",
      blank: "right",
      legacy: false,
      prompt: prompt("{a} × __ = {product}", "{a} × {answer} = {product}", "{a} ×", "= {product}"),
      steps: [
        step(1, { a: [2, 5], b: [2, 5] }, [{ op: "product_le", value: 25 }], feat("right", { span: [2, 5], digits: [1, 1] })),
        step(2, { a: [6, 9], b: [3, 9] }, [{ op: "product_le", value: 81 }], feat("right", { span: [6, 9], digits: [1, 1] })),
        step(3, { a: [10, 12], b: [3, 8] }, [{ op: "product_le", value: 100 }], feat("right", { span: [10, 12], digits: [2, 2] })),
      ],
    }),
  }),
  template({
    templateId: "mul-100-blank-left",
    version: 1,
    skillId: SKILLS.mul,
    promptShape: "inline_blank_left",
    bugRules: mulBugs,
    spec: spec({
      family: "mul",
      answerOp: "blank_a",
      compare: "exact",
      layout: "inline",
      blank: "left",
      legacy: false,
      prompt: prompt("__ × {b} = {product}", "{answer} × {b} = {product}", "", "× {b} = {product}"),
      steps: [
        step(1, { a: [2, 5], b: [2, 5] }, [{ op: "product_le", value: 25 }], feat("left", { span: [2, 5], digits: [1, 1] })),
        step(2, { a: [6, 9], b: [3, 9] }, [{ op: "product_le", value: 81 }], feat("left", { span: [6, 9], digits: [1, 1] })),
        step(3, { a: [10, 12], b: [3, 8] }, [{ op: "product_le", value: 100 }], feat("left", { span: [10, 12], digits: [2, 2] })),
      ],
    }),
  }),

  template({
    templateId: "div-100-v0",
    version: 0,
    skillId: SKILLS.div,
    promptShape: "legacy_stem",
    defaultFocus: "div.groups",
    bugRules: divBugs,
    spec: spec({
      family: "div",
      answerOp: "div",
      compare: "exact",
      layout: "inline",
      blank: "result",
      legacy: true,
      prompt: prompt("What is {a} ÷ {b}?", "{a} ÷ {b} = {answer}"),
      steps: [step(1, { a: [56, 56], b: [7, 7] }, [{ op: "div_exact" }], legacyWide("result"))],
    }),
  }),
  template({
    templateId: "div-100-inline",
    version: 1,
    skillId: SKILLS.div,
    promptShape: "inline_result",
    defaultFocus: "div.groups",
    bugRules: divBugs,
    spec: spec({
      family: "div",
      answerOp: "quot",
      compare: "exact",
      layout: "inline",
      blank: "result",
      legacy: false,
      prompt: prompt("What is {a} ÷ {b}?", "{a} ÷ {b} = {answer}"),
      steps: [
        step(1, { b: [2, 5], q: [2, 5] }, [{ op: "product_le", value: 20 }], feat("result", { span: [4, 20], digits: [1, 2] })),
        step(2, { b: [3, 9], q: [4, 9] }, [{ op: "product_ge", value: 24 }, { op: "product_le", value: 60 }], feat("result", { span: [24, 60], digits: [2, 2] })),
        step(3, { b: [6, 9], q: [8, 12] }, [{ op: "product_ge", value: 64 }, { op: "product_le", value: 100 }], feat("result", { span: [64, 100], digits: [2, 3] })),
      ],
    }),
  }),
  template({
    templateId: "div-100-blank",
    version: 1,
    skillId: SKILLS.div,
    promptShape: "inline_blank_right",
    defaultFocus: "div.split",
    bugRules: divisorBugs,
    spec: spec({
      family: "div",
      answerOp: "divisor",
      compare: "exact",
      layout: "inline",
      blank: "right",
      legacy: false,
      prompt: prompt("{a} ÷ __ = {q}", "{a} ÷ {answer} = {q}", "{a} ÷", "= {q}"),
      steps: [
        step(1, { b: [2, 5], q: [2, 5] }, [{ op: "product_le", value: 20 }], feat("right", { span: [4, 20], digits: [1, 2] })),
        step(2, { b: [3, 9], q: [4, 9] }, [{ op: "product_ge", value: 24 }, { op: "product_le", value: 60 }], feat("right", { span: [24, 60], digits: [2, 2] })),
        step(3, { b: [6, 9], q: [8, 12] }, [{ op: "product_ge", value: 64 }, { op: "product_le", value: 100 }], feat("right", { span: [64, 100], digits: [2, 3] })),
      ],
    }),
  }),
  template({
    templateId: "div-100-blank-left",
    version: 1,
    skillId: SKILLS.div,
    promptShape: "inline_blank_left",
    bugRules: divBugs,
    spec: spec({
      family: "div",
      answerOp: "dividend",
      compare: "exact",
      layout: "inline",
      blank: "left",
      legacy: false,
      prompt: prompt("__ ÷ {b} = {q}", "{answer} ÷ {b} = {q}", "", "÷ {b} = {q}"),
      steps: [
        step(1, { b: [2, 5], q: [2, 5] }, [{ op: "product_le", value: 20 }], feat("left", { span: [4, 20], digits: [1, 2] })),
        step(2, { b: [4, 8], q: [5, 8] }, [{ op: "product_ge", value: 24 }, { op: "product_le", value: 60 }], feat("left", { span: [24, 60], digits: [2, 2] })),
        step(3, { b: [7, 9], q: [9, 11] }, [{ op: "product_ge", value: 70 }, { op: "product_le", value: 99 }], feat("left", { span: [70, 99], digits: [2, 2] })),
      ],
    }),
  }),

  template({
    templateId: "mul-2d-v0",
    version: 0,
    skillId: SKILLS.mul2,
    promptShape: "legacy_stem",
    defaultFocus: "mul.place",
    bugRules: mul2Bugs,
    spec: spec({
      family: "mul",
      answerOp: "mul",
      compare: "exact",
      layout: "inline",
      blank: "result",
      legacy: true,
      prompt: prompt("What is {a} × {b}?", "{a} × {b} = {answer}"),
      steps: [step(1, { a: [24, 24], b: [3, 3] }, [], legacyWide("result"))],
    }),
  }),
  template({
    templateId: "mul-2d-inline",
    version: 1,
    skillId: SKILLS.mul2,
    promptShape: "inline_result",
    defaultFocus: "mul.place",
    bugRules: mul2Bugs,
    spec: spec({
      family: "mul",
      answerOp: "mul",
      compare: "exact",
      layout: "inline",
      blank: "result",
      legacy: false,
      prompt: prompt("What is {a} × {b}?", "{a} × {b} = {answer}"),
      steps: [
        step(1, { a: [11, 24], b: [2, 3] }, [{ op: "mul_carries_eq", value: 0 }], feat("result", { regroups: [0, 0], digits: [2, 2] })),
        step(2, { a: [14, 48], b: [3, 6] }, [{ op: "mul_carries_eq", value: 1 }], feat("result", { regroups: [1, 1], digits: [2, 2] })),
        step(3, { a: [25, 79], b: [4, 9] }, [{ op: "mul_carries_eq", value: 2 }], feat("result", { regroups: [2, 3], digits: [2, 2] })),
      ],
    }),
  }),
  template({
    templateId: "mul-2d-blank",
    version: 1,
    skillId: SKILLS.mul2,
    promptShape: "inline_blank_right",
    defaultFocus: "mul.place",
    bugRules: mul2Bugs,
    spec: spec({
      family: "mul",
      answerOp: "blank_b",
      compare: "exact",
      layout: "inline",
      blank: "right",
      legacy: false,
      prompt: prompt("{a} × __ = {product}", "{a} × {answer} = {product}", "{a} ×", "= {product}"),
      steps: [
        step(1, { a: [11, 24], b: [2, 3] }, [{ op: "mul_carries_eq", value: 0 }], feat("right", { regroups: [0, 0], digits: [2, 2] })),
        step(2, { a: [14, 48], b: [3, 6] }, [{ op: "mul_carries_eq", value: 1 }], feat("right", { regroups: [1, 1], digits: [2, 2] })),
        step(3, { a: [25, 79], b: [4, 9] }, [{ op: "mul_carries_eq", value: 2 }], feat("right", { regroups: [2, 3], digits: [2, 2] })),
      ],
    }),
  }),
  template({
    templateId: "mul-2d-column",
    version: 1,
    skillId: SKILLS.mul2,
    promptShape: "column_result",
    bugRules: mul2Bugs,
    spec: spec({
      family: "mul",
      answerOp: "mul",
      compare: "exact",
      layout: "column",
      blank: "result",
      legacy: false,
      prompt: prompt("{a} × {b}", "{a} × {b} = {answer}", "", "", ["  {a}", "× {b}"]),
      steps: [
        step(1, { a: [11, 24], b: [2, 3] }, [{ op: "mul_carries_eq", value: 0 }], feat("result", { regroups: [0, 0], digits: [2, 2] })),
        step(2, { a: [14, 48], b: [3, 6] }, [{ op: "mul_carries_eq", value: 1 }], feat("result", { regroups: [1, 1], digits: [2, 2] })),
        step(3, { a: [25, 79], b: [4, 9] }, [{ op: "mul_carries_eq", value: 2 }], feat("result", { regroups: [2, 3], digits: [2, 2] })),
      ],
    }),
  }),

  template({
    templateId: "div-2d-v0",
    version: 0,
    skillId: SKILLS.div2,
    promptShape: "legacy_stem",
    defaultFocus: "div.split",
    bugRules: divBugs,
    spec: spec({
      family: "div",
      answerOp: "div",
      compare: "exact",
      layout: "inline",
      blank: "result",
      legacy: true,
      prompt: prompt("What is {a} ÷ {b}?", "{a} ÷ {b} = {answer}"),
      steps: [step(1, { a: [96, 96], b: [4, 4] }, [{ op: "div_exact" }], legacyWide("result"))],
    }),
  }),
  template({
    templateId: "div-2d-inline",
    version: 1,
    skillId: SKILLS.div2,
    promptShape: "inline_result",
    defaultFocus: "div.split",
    bugRules: divBugs,
    spec: spec({
      family: "div",
      answerOp: "quot",
      compare: "exact",
      layout: "inline",
      blank: "result",
      legacy: false,
      prompt: prompt("What is {a} ÷ {b}?", "{a} ÷ {b} = {answer}"),
      steps: [
        step(1, { b: [2, 4], q: [5, 9] }, [{ op: "product_ge", value: 12 }, { op: "product_le", value: 36 }], feat("result", { span: [12, 36], digits: [2, 2] })),
        step(2, { b: [3, 8], q: [6, 9] }, [{ op: "product_ge", value: 40 }, { op: "product_le", value: 63 }], feat("result", { span: [40, 63], digits: [2, 2] })),
        step(3, { b: [4, 9], q: [8, 12] }, [{ op: "product_ge", value: 64 }, { op: "product_le", value: 99 }], feat("result", { span: [64, 99], digits: [2, 2] })),
      ],
    }),
  }),
  template({
    templateId: "div-2d-blank",
    version: 1,
    skillId: SKILLS.div2,
    promptShape: "inline_blank_right",
    defaultFocus: "div.split",
    bugRules: divisorBugs,
    spec: spec({
      family: "div",
      answerOp: "divisor",
      compare: "exact",
      layout: "inline",
      blank: "right",
      legacy: false,
      prompt: prompt("{a} ÷ __ = {q}", "{a} ÷ {answer} = {q}", "{a} ÷", "= {q}"),
      steps: [
        step(1, { b: [2, 4], q: [5, 8] }, [{ op: "product_ge", value: 12 }, { op: "product_le", value: 32 }], feat("right", { span: [12, 32], digits: [2, 2] })),
        step(2, { b: [4, 7], q: [6, 9] }, [{ op: "product_ge", value: 36 }, { op: "product_le", value: 60 }], feat("right", { span: [36, 60], digits: [2, 2] })),
        step(3, { b: [6, 9], q: [9, 12] }, [{ op: "product_ge", value: 64 }, { op: "product_le", value: 99 }], feat("right", { span: [64, 99], digits: [2, 2] })),
      ],
    }),
  }),
  template({
    templateId: "div-2d-column",
    version: 1,
    skillId: SKILLS.div2,
    promptShape: "column_result",
    bugRules: divBugs,
    spec: spec({
      family: "div",
      answerOp: "quot",
      compare: "exact",
      layout: "column",
      blank: "result",
      legacy: false,
      prompt: prompt("{a} ÷ {b}", "{a} ÷ {b} = {answer}", "", "", ["  {a}", "÷ {b}"]),
      steps: [
        step(1, { b: [2, 4], q: [5, 9] }, [{ op: "product_ge", value: 12 }, { op: "product_le", value: 36 }], feat("result", { span: [12, 36], digits: [2, 2] })),
        step(2, { b: [3, 8], q: [6, 9] }, [{ op: "product_ge", value: 40 }, { op: "product_le", value: 63 }], feat("result", { span: [40, 63], digits: [2, 2] })),
        step(3, { b: [4, 9], q: [8, 12] }, [{ op: "product_ge", value: 64 }, { op: "product_le", value: 99 }], feat("result", { span: [64, 99], digits: [2, 2] })),
      ],
    }),
  }),

  template({
    templateId: "frac-compare-v0",
    version: 0,
    skillId: SKILLS.compare,
    promptShape: "legacy_stem",
    defaultFocus: "frac.unit",
    bugRules: largerBugs,
    spec: spec({
      family: "frac_compare",
      answerOp: "larger_unit",
      compare: "rational",
      layout: "inline",
      blank: "result",
      legacy: true,
      prompt: prompt("Which is larger, 1/{d1} or 1/{d2}?", "{answer}"),
      steps: [step(1, { d1: [2, 2], d2: [4, 4] }, [], legacyWide("result"))],
    }),
  }),
  template({
    templateId: "frac-compare-larger",
    version: 1,
    skillId: SKILLS.compare,
    promptShape: "which_larger",
    defaultFocus: "frac.unit",
    bugRules: largerBugs,
    spec: spec({
      family: "frac_compare",
      answerOp: "larger_unit",
      compare: "rational",
      layout: "inline",
      blank: "result",
      legacy: false,
      prompt: prompt("Which is larger, 1/{d1} or 1/{d2}?", "{answer}"),
      steps: [
        step(1, { d1: [2, 4], d2: [2, 4] }, [], feat("result", { span: [2, 4], digits: [1, 1], denomRelation: "unit", likeDenominators: false })),
        step(2, { d1: [2, 9], d2: [5, 9] }, [{ op: "span_between", min: 5, max: 9 }], feat("result", { span: [5, 9], digits: [1, 1], denomRelation: "unit", likeDenominators: false })),
        step(3, { d1: [2, 12], d2: [10, 12] }, [{ op: "span_between", min: 10, max: 12 }], feat("result", { span: [10, 12], digits: [2, 2], denomRelation: "unit", likeDenominators: false })),
      ],
    }),
  }),
  template({
    templateId: "frac-compare-smaller",
    version: 1,
    skillId: SKILLS.compare,
    promptShape: "which_smaller",
    defaultFocus: "frac.unit",
    bugRules: smallerBugs,
    spec: spec({
      family: "frac_compare",
      answerOp: "smaller_unit",
      compare: "rational",
      layout: "inline",
      blank: "result",
      legacy: false,
      prompt: prompt("Which is smaller, 1/{d1} or 1/{d2}?", "{answer}"),
      steps: [
        step(1, { d1: [2, 4], d2: [2, 4] }, [], feat("result", { span: [2, 4], digits: [1, 1], denomRelation: "unit", likeDenominators: false })),
        step(2, { d1: [2, 9], d2: [5, 9] }, [{ op: "span_between", min: 5, max: 9 }], feat("result", { span: [5, 9], digits: [1, 1], denomRelation: "unit", likeDenominators: false })),
        step(3, { d1: [2, 12], d2: [10, 12] }, [{ op: "span_between", min: 10, max: 12 }], feat("result", { span: [10, 12], digits: [2, 2], denomRelation: "unit", likeDenominators: false })),
      ],
    }),
  }),
  template({
    templateId: "frac-compare-symbol",
    version: 1,
    skillId: SKILLS.compare,
    promptShape: "inline_blank_symbol",
    bugRules: largerBugs,
    spec: spec({
      family: "frac_compare",
      answerOp: "symbol_gt",
      compare: "exact",
      layout: "inline",
      blank: "symbol",
      legacy: false,
      prompt: prompt("1/{d1} __ 1/{d2}", "1/{d1} {answer} 1/{d2}", "1/{d1}", "1/{d2}"),
      steps: [
        step(1, { d1: [2, 4], d2: [2, 4] }, [], feat("symbol", { span: [2, 4], digits: [1, 1], denomRelation: "unit", likeDenominators: false })),
        step(2, { d1: [2, 9], d2: [5, 9] }, [{ op: "span_between", min: 5, max: 9 }], feat("symbol", { span: [5, 9], digits: [1, 1], denomRelation: "unit", likeDenominators: false })),
        step(3, { d1: [2, 12], d2: [10, 12] }, [{ op: "span_between", min: 10, max: 12 }], feat("symbol", { span: [10, 12], digits: [2, 2], denomRelation: "unit", likeDenominators: false })),
      ],
    }),
  }),

  template({
    templateId: "frac-equiv-v0",
    version: 0,
    skillId: SKILLS.equiv,
    promptShape: "legacy_choice",
    defaultFocus: "frac.equiv",
    bugRules: [
      { id: "reduce", op: "scale_reduce", cueKey: "frac.lowest" },
      { id: "off-choice", op: "scale_add", cueKey: "frac.equiv" },
    ],
    spec: spec({
      family: "frac_equiv",
      answerOp: "scale_exact",
      compare: "exact",
      layout: "inline",
      blank: "result",
      legacy: true,
      prompt: prompt("Which fraction equals 1/2? Answer 2/4 or 2/3.", "2/4"),
      steps: [step(1, { n: [1, 1], d: [2, 2], k: [2, 2] }, [], legacyWide("result"))],
    }),
  }),
  template({
    templateId: "frac-equiv-scale",
    version: 1,
    skillId: SKILLS.equiv,
    promptShape: "missing_numerator",
    defaultFocus: "frac.equiv",
    bugRules: [
      { id: "scale-add", op: "scale_add", cueKey: "frac.equiv" },
      { id: "scale-both", op: "scale_both", cueKey: "frac.lowest" },
    ],
    spec: spec({
      family: "frac_equiv",
      answerOp: "scale_num",
      compare: "exact",
      layout: "inline",
      blank: "numerator",
      legacy: false,
      prompt: prompt("{n}/{d} = __/{den}", "{n}/{d} = {answer}/{den}", "{n}/{d} =", "/{den}"),
      steps: [
        step(1, { n: [1, 1], d: [2, 3], k: [2, 2] }, [], feat("numerator", { span: [2, 3], digits: [1, 1] })),
        step(2, { n: [1, 2], d: [2, 3], k: [4, 4] }, [], feat("numerator", { span: [4, 4], digits: [1, 1] })),
        step(3, { n: [1, 3], d: [2, 5], k: [6, 6] }, [], feat("numerator", { span: [6, 6], digits: [1, 1] })),
      ],
    }),
  }),
  template({
    templateId: "frac-equiv-lowest",
    version: 1,
    skillId: SKILLS.equiv,
    promptShape: "lowest_terms",
    defaultFocus: "frac.lowest",
    requireForm: "lowest_terms",
    bugRules: [
      { id: "minus", op: "lowest_minus", cueKey: "frac.lowest" },
      { id: "num-only", op: "lowest_num_only", cueKey: "frac.equiv" },
    ],
    spec: spec({
      family: "frac_form",
      answerOp: "lowest",
      compare: "rational",
      layout: "inline",
      blank: "result",
      legacy: false,
      prompt: prompt("Write {n}/{d} in lowest terms.", "{answer}"),
      steps: [
        step(1, { n: [2, 6], d: [4, 8] }, [{ op: "gcd_gt_one" }, { op: "span_between", min: 4, max: 8 }], feat("result", { span: [4, 8], digits: [1, 1] })),
        step(2, { n: [4, 10], d: [6, 12] }, [{ op: "gcd_gt_one" }, { op: "span_between", min: 9, max: 12 }], feat("result", { span: [9, 12], digits: [1, 2] })),
        step(3, { n: [6, 16], d: [10, 16] }, [{ op: "gcd_gt_one" }, { op: "span_between", min: 13, max: 16 }], feat("result", { span: [13, 16], digits: [2, 2] })),
      ],
    }),
  }),
  template({
    templateId: "frac-equiv-improper",
    version: 1,
    skillId: SKILLS.equiv,
    promptShape: "to_improper",
    defaultFocus: "frac.form",
    requireForm: "improper",
    bugRules: [
      { id: "form-add", op: "form_add", cueKey: "frac.form" },
      { id: "form-swap", op: "form_swap", cueKey: "frac.equiv" },
    ],
    spec: spec({
      family: "frac_form",
      answerOp: "to_improper",
      compare: "rational",
      layout: "inline",
      blank: "result",
      legacy: false,
      prompt: prompt("Write {whole} {n}/{d} as an improper fraction.", "{answer}"),
      steps: [
        step(1, { whole: [1, 1], n: [2, 2], d: [5, 6] }, [{ op: "proper_part" }], feat("result", { span: [5, 6], digits: [1, 1] })),
        step(2, { whole: [2, 2], n: [1, 1], d: [3, 4] }, [{ op: "proper_part" }], feat("result", { span: [3, 4], digits: [1, 1] })),
        step(3, { whole: [3, 3], n: [1, 2], d: [7, 9] }, [{ op: "proper_part" }], feat("result", { span: [7, 9], digits: [1, 1] })),
      ],
    }),
  }),
  template({
    templateId: "frac-equiv-mixed",
    version: 1,
    skillId: SKILLS.equiv,
    promptShape: "to_mixed",
    defaultFocus: "frac.form",
    requireForm: "mixed",
    bugRules: [
      { id: "form-add", op: "form_add", cueKey: "frac.form" },
      { id: "form-swap", op: "form_swap", cueKey: "frac.lowest" },
    ],
    spec: spec({
      family: "frac_form",
      answerOp: "to_mixed",
      compare: "rational",
      layout: "inline",
      blank: "result",
      legacy: false,
      prompt: prompt("Write {n}/{d} as a mixed number.", "{answer}"),
      steps: [
        step(1, { n: [3, 5], d: [2, 2] }, [{ op: "improper_source" }], feat("result", { span: [3, 5], digits: [1, 1] })),
        step(2, { n: [7, 11], d: [3, 4] }, [{ op: "improper_source" }], feat("result", { span: [7, 11], digits: [1, 2] })),
        step(3, { n: [13, 20], d: [5, 8] }, [{ op: "improper_source" }], feat("result", { span: [13, 20], digits: [2, 2] })),
      ],
    }),
  }),

  template({
    templateId: "frac-add-like-v0",
    version: 0,
    skillId: SKILLS.addLike,
    promptShape: "legacy_stem",
    defaultFocus: "frac.like",
    bugRules: likeAddBugs,
    spec: spec({
      family: "frac_add",
      answerOp: "frac_add_like",
      compare: "rational",
      layout: "inline",
      blank: "result",
      legacy: true,
      prompt: prompt("What is {n1}/{d} + {n2}/{d}?", "{n1}/{d} + {n2}/{d} = {answer}"),
      steps: [step(1, { n1: [1, 1], n2: [2, 2], d: [4, 4] }, [], legacyWide("result"))],
    }),
  }),
  template({
    templateId: "frac-add-like-inline",
    version: 1,
    skillId: SKILLS.addLike,
    promptShape: "inline_result",
    defaultFocus: "frac.like",
    bugRules: likeAddBugs,
    spec: spec({
      family: "frac_add",
      answerOp: "frac_add_like",
      compare: "rational",
      layout: "inline",
      blank: "result",
      legacy: false,
      prompt: prompt("What is {n1}/{d} + {n2}/{d}?", "{n1}/{d} + {n2}/{d} = {answer}"),
      steps: [
        step(1, { n1: [1, 3], n2: [1, 3], d: [5, 9] }, [{ op: "sum_lt_den" }], feat("result", { regroups: [0, 0], likeDenominators: true, denomRelation: "like", digits: [1, 1] })),
        step(2, { n1: [1, 6], n2: [1, 6], d: [3, 8] }, [{ op: "sum_eq_den" }], feat("result", { regroups: [1, 1], likeDenominators: true, denomRelation: "like", digits: [1, 1] })),
        step(3, { n1: [2, 6], n2: [2, 6], d: [3, 7] }, [{ op: "sum_gt_den" }], feat("result", { regroups: [2, 2], likeDenominators: true, denomRelation: "like", digits: [1, 1] })),
      ],
    }),
  }),
  template({
    templateId: "frac-add-like-blank",
    version: 1,
    skillId: SKILLS.addLike,
    promptShape: "inline_blank_right",
    defaultFocus: "frac.like",
    bugRules: likeAddBugs,
    spec: spec({
      family: "frac_add",
      answerOp: "frac_add_gap",
      compare: "exact",
      layout: "inline",
      blank: "right",
      legacy: false,
      prompt: prompt("{n1}/{d} + __/{d} = {sumN}/{d}", "{n1}/{d} + {answer}/{d} = {sumN}/{d}", "{n1}/{d} +", "/{d} = {sumN}/{d}"),
      steps: [
        step(1, { n1: [1, 3], sumN: [3, 6], d: [6, 9] }, [{ op: "sum_lt_den" }], feat("right", { regroups: [0, 0], likeDenominators: true, denomRelation: "like", digits: [1, 1] })),
        step(2, { n1: [1, 4], sumN: [4, 8], d: [4, 8] }, [{ op: "sum_eq_den" }], feat("right", { regroups: [1, 1], likeDenominators: true, denomRelation: "like", digits: [1, 1] })),
        step(3, { n1: [2, 4], sumN: [5, 9], d: [3, 6] }, [{ op: "sum_gt_den" }], feat("right", { regroups: [2, 2], likeDenominators: true, denomRelation: "like", digits: [1, 1] })),
      ],
    }),
  }),
  template({
    templateId: "frac-add-like-column",
    version: 1,
    skillId: SKILLS.addLike,
    promptShape: "column_result",
    bugRules: likeAddBugs,
    spec: spec({
      family: "frac_add",
      answerOp: "frac_add_like",
      compare: "rational",
      layout: "column",
      blank: "result",
      legacy: false,
      prompt: prompt("{n1}/{d} + {n2}/{d}", "{n1}/{d} + {n2}/{d} = {answer}", "", "", ["  {n1}/{d}", "+ {n2}/{d}"]),
      steps: [
        step(1, { n1: [1, 3], n2: [1, 3], d: [5, 9] }, [{ op: "sum_lt_den" }], feat("result", { regroups: [0, 0], likeDenominators: true, denomRelation: "like", digits: [1, 1] })),
        step(2, { n1: [1, 6], n2: [1, 6], d: [3, 8] }, [{ op: "sum_eq_den" }], feat("result", { regroups: [1, 1], likeDenominators: true, denomRelation: "like", digits: [1, 1] })),
        step(3, { n1: [2, 6], n2: [2, 6], d: [3, 7] }, [{ op: "sum_gt_den" }], feat("result", { regroups: [2, 2], likeDenominators: true, denomRelation: "like", digits: [1, 1] })),
      ],
    }),
  }),

  template({
    templateId: "frac-add-unlike-v0",
    version: 0,
    skillId: SKILLS.addUnlike,
    promptShape: "legacy_stem",
    defaultFocus: "frac.unlike",
    bugRules: unlikeBugs,
    spec: spec({
      family: "frac_add",
      answerOp: "frac_add_unlike",
      compare: "rational",
      layout: "inline",
      blank: "result",
      legacy: true,
      prompt: prompt("What is {n1}/{d1} + {n2}/{d2}?", "{n1}/{d1} + {n2}/{d2} = {answer}"),
      steps: [step(1, { n1: [1, 1], d1: [2, 2], n2: [1, 1], d2: [4, 4] }, [], legacyWide("result"))],
    }),
  }),
  template({
    templateId: "frac-add-unlike-inline",
    version: 1,
    skillId: SKILLS.addUnlike,
    promptShape: "inline_result",
    defaultFocus: "frac.unlike",
    bugRules: unlikeBugs,
    spec: spec({
      family: "frac_add",
      answerOp: "frac_add_unlike",
      compare: "rational",
      layout: "inline",
      blank: "result",
      legacy: false,
      prompt: prompt("What is {n1}/{d1} + {n2}/{d2}?", "{n1}/{d1} + {n2}/{d2} = {answer}"),
      steps: [
        step(1, { n1: [1, 2], d1: [2, 4], n2: [1, 2], d2: [4, 8] }, [{ op: "den_multiple" }], feat("result", { denomRelation: "multiple", likeDenominators: false, digits: [1, 1], span: [2, 8] })),
        step(2, { n1: [1, 2], d1: [2, 5], n2: [1, 2], d2: [3, 5] }, [{ op: "den_unlike" }, { op: "span_between", min: 2, max: 5 }], feat("result", { denomRelation: "unlike", likeDenominators: false, digits: [1, 1], span: [2, 5] })),
        step(3, { n1: [1, 3], d1: [3, 8], n2: [1, 3], d2: [8, 12] }, [{ op: "den_unlike" }, { op: "span_between", min: 8, max: 12 }], feat("result", { denomRelation: "unlike", likeDenominators: false, digits: [1, 2], span: [8, 12] })),
      ],
    }),
  }),
  template({
    templateId: "frac-add-unlike-blank",
    version: 1,
    skillId: SKILLS.addUnlike,
    promptShape: "missing_addend",
    defaultFocus: "frac.unlike",
    bugRules: unlikeBugs,
    spec: spec({
      family: "frac_add",
      answerOp: "frac_add_unlike",
      compare: "rational",
      layout: "inline",
      blank: "right",
      legacy: false,
      prompt: prompt("{n1}/{d1} + {n2}/{d2} = __", "{n1}/{d1} + {n2}/{d2} = {answer}", "{n1}/{d1} + {n2}/{d2} =", ""),
      steps: [
        step(1, { n1: [1, 2], d1: [2, 4], n2: [1, 2], d2: [4, 8] }, [{ op: "den_multiple" }], feat("right", { denomRelation: "multiple", likeDenominators: false, span: [2, 8] })),
        step(2, { n1: [1, 2], d1: [2, 5], n2: [1, 2], d2: [3, 5] }, [{ op: "den_unlike" }, { op: "span_between", min: 2, max: 5 }], feat("right", { denomRelation: "unlike", likeDenominators: false, span: [2, 5] })),
        step(3, { n1: [1, 3], d1: [3, 8], n2: [1, 3], d2: [8, 12] }, [{ op: "den_unlike" }, { op: "span_between", min: 8, max: 12 }], feat("right", { denomRelation: "unlike", likeDenominators: false, span: [8, 12] })),
      ],
    }),
  }),
  template({
    templateId: "frac-add-unlike-column",
    version: 1,
    skillId: SKILLS.addUnlike,
    promptShape: "column_result",
    bugRules: unlikeBugs,
    spec: spec({
      family: "frac_add",
      answerOp: "frac_add_unlike",
      compare: "rational",
      layout: "column",
      blank: "result",
      legacy: false,
      prompt: prompt("{n1}/{d1} + {n2}/{d2}", "{n1}/{d1} + {n2}/{d2} = {answer}", "", "", ["  {n1}/{d1}", "+ {n2}/{d2}"]),
      steps: [
        step(1, { n1: [1, 2], d1: [2, 4], n2: [1, 2], d2: [4, 8] }, [{ op: "den_multiple" }], feat("result", { denomRelation: "multiple", likeDenominators: false, span: [2, 8] })),
        step(2, { n1: [1, 2], d1: [2, 5], n2: [1, 2], d2: [3, 5] }, [{ op: "den_unlike" }, { op: "span_between", min: 2, max: 5 }], feat("result", { denomRelation: "unlike", likeDenominators: false, span: [2, 5] })),
        step(3, { n1: [1, 3], d1: [3, 8], n2: [1, 3], d2: [8, 12] }, [{ op: "den_unlike" }, { op: "span_between", min: 8, max: 12 }], feat("result", { denomRelation: "unlike", likeDenominators: false, span: [8, 12] })),
      ],
    }),
  }),

  template({
    templateId: "frac-sub-like-v0",
    version: 0,
    skillId: SKILLS.subLike,
    promptShape: "legacy_stem",
    defaultFocus: "frac.sub",
    bugRules: subFracBugs,
    spec: spec({
      family: "frac_sub",
      answerOp: "frac_sub_like",
      compare: "rational",
      layout: "inline",
      blank: "result",
      legacy: true,
      prompt: prompt("What is {n1}/{d} - {n2}/{d}?", "{n1}/{d} - {n2}/{d} = {answer}"),
      steps: [step(1, { n1: [3, 3], n2: [1, 1], d: [4, 4] }, [{ op: "diff_positive" }], legacyWide("result"))],
    }),
  }),
  template({
    templateId: "frac-sub-like-inline",
    version: 1,
    skillId: SKILLS.subLike,
    promptShape: "inline_result",
    defaultFocus: "frac.sub",
    bugRules: subFracBugs,
    spec: spec({
      family: "frac_sub",
      answerOp: "frac_sub_like",
      compare: "rational",
      layout: "inline",
      blank: "result",
      legacy: false,
      prompt: prompt("What is {n1}/{d} - {n2}/{d}?", "{n1}/{d} - {n2}/{d} = {answer}"),
      steps: [
        step(1, { n1: [2, 5], n2: [1, 3], d: [3, 6] }, [{ op: "diff_positive" }, { op: "result_lowest" }, { op: "span_between", min: 3, max: 6 }], feat("result", { regroups: [0, 0], likeDenominators: true, denomRelation: "like", span: [3, 6] })),
        step(2, { n1: [3, 7], n2: [1, 3], d: [4, 8] }, [{ op: "diff_positive" }, { op: "result_reduces" }, { op: "span_between", min: 4, max: 8 }], feat("result", { regroups: [1, 1], likeDenominators: true, denomRelation: "like", span: [4, 8] })),
        step(3, { n1: [5, 11], n2: [1, 4], d: [9, 12] }, [{ op: "diff_positive" }, { op: "result_reduces" }, { op: "span_between", min: 9, max: 12 }], feat("result", { regroups: [1, 1], likeDenominators: true, denomRelation: "like", span: [9, 12], digits: [1, 2] })),
      ],
    }),
  }),
  template({
    templateId: "frac-sub-like-blank",
    version: 1,
    skillId: SKILLS.subLike,
    promptShape: "inline_blank_right",
    defaultFocus: "frac.sub",
    bugRules: subFracBugs,
    spec: spec({
      family: "frac_sub",
      answerOp: "frac_sub_like",
      compare: "rational",
      layout: "inline",
      blank: "right",
      legacy: false,
      prompt: prompt("{n1}/{d} - {n2}/{d} = __", "{n1}/{d} - {n2}/{d} = {answer}", "{n1}/{d} - {n2}/{d} =", ""),
      steps: [
        step(1, { n1: [2, 5], n2: [1, 3], d: [3, 6] }, [{ op: "diff_positive" }, { op: "result_lowest" }, { op: "span_between", min: 3, max: 6 }], feat("right", { regroups: [0, 0], likeDenominators: true, denomRelation: "like", span: [3, 6] })),
        step(2, { n1: [3, 7], n2: [1, 3], d: [4, 8] }, [{ op: "diff_positive" }, { op: "result_reduces" }, { op: "span_between", min: 4, max: 8 }], feat("right", { regroups: [1, 1], likeDenominators: true, denomRelation: "like", span: [4, 8] })),
        step(3, { n1: [5, 11], n2: [1, 4], d: [9, 12] }, [{ op: "diff_positive" }, { op: "result_reduces" }, { op: "span_between", min: 9, max: 12 }], feat("right", { regroups: [1, 1], likeDenominators: true, denomRelation: "like", span: [9, 12], digits: [1, 2] })),
      ],
    }),
  }),
  template({
    templateId: "frac-sub-like-column",
    version: 1,
    skillId: SKILLS.subLike,
    promptShape: "column_result",
    bugRules: subFracBugs,
    spec: spec({
      family: "frac_sub",
      answerOp: "frac_sub_like",
      compare: "rational",
      layout: "column",
      blank: "result",
      legacy: false,
      prompt: prompt("{n1}/{d} - {n2}/{d}", "{n1}/{d} - {n2}/{d} = {answer}", "", "", ["  {n1}/{d}", "- {n2}/{d}"]),
      steps: [
        step(1, { n1: [2, 5], n2: [1, 3], d: [3, 6] }, [{ op: "diff_positive" }, { op: "result_lowest" }, { op: "span_between", min: 3, max: 6 }], feat("result", { regroups: [0, 0], likeDenominators: true, denomRelation: "like", span: [3, 6] })),
        step(2, { n1: [3, 7], n2: [1, 3], d: [4, 8] }, [{ op: "diff_positive" }, { op: "result_reduces" }, { op: "span_between", min: 4, max: 8 }], feat("result", { regroups: [1, 1], likeDenominators: true, denomRelation: "like", span: [4, 8] })),
        step(3, { n1: [5, 11], n2: [1, 4], d: [9, 12] }, [{ op: "diff_positive" }, { op: "result_reduces" }, { op: "span_between", min: 9, max: 12 }], feat("result", { regroups: [1, 1], likeDenominators: true, denomRelation: "like", span: [9, 12], digits: [1, 2] })),
      ],
    }),
  }),
];

/**
 * Step-1 operand ranges widened inside the existing feature band.
 * Version 1 stays immutable. Issuance uses the newest active version.
 */
const STEP_ONE_WIDENED: Array<{ templateId: string; slots: Record<string, [number, number]> }> = [
  // span stays 2–3, one digit. n=2,k=2 is ambiguous (scale_add equals the answer) and drops out.
  { templateId: "frac-equiv-scale", slots: { n: [1, 3], d: [2, 3], k: [2, 3] } },
  // span stays 5–6, one digit, proper fraction part. n = whole is ambiguous with form_swap.
  { templateId: "frac-equiv-improper", slots: { whole: [1, 6], n: [1, 5], d: [5, 6] } },
  // span stays 3–5. Whole answers stay ineligible. Most remaining pairs match form_swap.
  { templateId: "frac-equiv-mixed", slots: { n: [3, 5], d: [2, 5] } },
];

function widenedStepOne(templateId: string, step1: Record<string, [number, number]>): TemplateVersion {
  const base = SEEDED_TEMPLATES.find((template) => template.templateId === templateId);
  if (!base) throw new Error(`Missing template ${templateId}`);
  return {
    ...base,
    version: base.version + 1,
    spec: {
      ...base.spec,
      steps: base.spec.steps.map((variant) =>
        variant.assignedStep === 1 ? { ...variant, slots: slots(step1) } : variant,
      ),
    },
  };
}

const WITH_STEP_ONE: TemplateVersion[] = [
  ...SEEDED_TEMPLATES,
  ...STEP_ONE_WIDENED.map((widened) => widenedStepOne(widened.templateId, widened.slots)),
];

/**
 * Later versions widen a single step's operand box inside that step's
 * feature band. Earlier versions stay in the catalog unchanged.
 */
const LATER_WIDENED: Array<{
  templateId: string;
  fromVersion: number;
  slots: Partial<Record<1 | 2 | 3, Record<string, [number, number]>>>;
}> = [
  // scale step 2 span stays 4. k stays 4, so n and d can run up to 4.
  { templateId: "frac-equiv-scale", fromVersion: 2, slots: { 2: { n: [1, 4], d: [2, 4], k: [4, 4] } } },
  // improper step 2 span stays 3–4; step 3 span stays 7–9. n stays a proper part.
  {
    templateId: "frac-equiv-improper",
    fromVersion: 2,
    slots: {
      2: { whole: [2, 4], n: [1, 2], d: [3, 4] },
      3: { whole: [3, 4], n: [1, 2], d: [7, 9] },
    },
  },
  // mixed step 2 span stays 7–11. d=5 is still inside that span.
  { templateId: "frac-equiv-mixed", fromVersion: 2, slots: { 2: { n: [7, 11], d: [3, 5] } } },
  // dividend stays inside span 4–20. q=6 is accepted only when the product still fits.
  { templateId: "div-100-inline", fromVersion: 1, slots: { 1: { b: [2, 5], q: [2, 6] } } },
  { templateId: "div-100-blank", fromVersion: 1, slots: { 1: { b: [2, 5], q: [2, 6] } } },
  // dividend stays inside span 70–99.
  { templateId: "div-100-blank-left", fromVersion: 1, slots: { 3: { b: [7, 9], q: [9, 12] } } },
  // dividend stays inside span 36–60.
  { templateId: "div-2d-blank", fromVersion: 1, slots: { 2: { b: [4, 7], q: [6, 10] } } },
];

/**
 * Step-1 improper answers keep denominators 5 and 6 and cap the whole part at 3.
 * A whole part of 4, 5, or 6 makes the operand span 5–6, which is this step's
 * band, not step 2's span of 3–4, so those answers are dropped from step 1.
 */
function improperWholeCap(versions: readonly TemplateVersion[]): TemplateVersion {
  return withWiderSlots(versions, "frac-equiv-improper", 3, {
    1: { whole: [1, 3], n: [1, 5], d: [5, 6] },
  });
}

function withWiderSlots(
  versions: readonly TemplateVersion[],
  templateId: string,
  fromVersion: number,
  slotsByStep: Partial<Record<1 | 2 | 3, Record<string, [number, number]>>>,
): TemplateVersion {
  const base = versions.find((template) => template.templateId === templateId && template.version === fromVersion);
  if (!base) throw new Error(`Missing template ${templateId}@${fromVersion}`);
  return {
    ...base,
    version: fromVersion + 1,
    spec: {
      ...base.spec,
      steps: base.spec.steps.map((variant) => {
        const next = slotsByStep[variant.assignedStep];
        return next ? { ...variant, slots: slots(next) } : variant;
      }),
    },
  };
}

const WITH_LATER_SLOTS: TemplateVersion[] = [
  ...WITH_STEP_ONE,
  ...LATER_WIDENED.map((widened) =>
    withWiderSlots(WITH_STEP_ONE, widened.templateId, widened.fromVersion, widened.slots),
  ),
];

export const TEMPLATE_VERSIONS: TemplateVersion[] = [
  ...WITH_LATER_SLOTS,
  improperWholeCap(WITH_LATER_SLOTS),
];

export function newestTemplate(templateId: string): TemplateVersion | undefined {
  let newest: TemplateVersion | undefined;
  for (const template of TEMPLATE_VERSIONS) {
    if (template.templateId !== templateId) continue;
    if (!newest || template.version > newest.version) newest = template;
  }
  return newest;
}

export function templatesForSkill(skillId: string, versionAtLeast = 0): TemplateVersion[] {
  return TEMPLATE_VERSIONS.filter(
    (template) => template.skillId === skillId && template.version >= versionAtLeast,
  );
}

/** Newest generated version of each template. Legacy v0 rows are not included. */
export function generatedTemplates(skillId: string): TemplateVersion[] {
  const newest = new Map<string, TemplateVersion>();
  for (const template of TEMPLATE_VERSIONS) {
    if (template.skillId !== skillId || template.version < 1 || template.spec.legacy) continue;
    const current = newest.get(template.templateId);
    if (!current || template.version > current.version) newest.set(template.templateId, template);
  }
  return [...newest.values()];
}
