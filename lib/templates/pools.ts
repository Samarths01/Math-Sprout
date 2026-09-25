import { TEMPLATE_VERSIONS } from "@/lib/templates/catalog";
import { eligibleDraws } from "@/lib/templates/engine";
import type { TemplateVersion } from "@/lib/templates/types";

/** Distinct drawable items one template version must hold at a step. */
export const MIN_PER_TEMPLATE_STEP = 10;

/** Distinct drawable items one skill must hold at a step, across its templates. */
export const MIN_PER_SKILL_STEP = 20;

const LEGACY_REASON =
  "The v0 seed is the one original problem. Widening that fixed item would make it a different template. The generated templates carry the step pool.";

const FROZEN_REASON =
  "This version is frozen as issued. A later version widens the operand box inside the same step band.";

const COMPARE_STEP_ONE =
  "Step 1 span is 2–4. The only unequal unit pairs are (2,3), (2,4), (3,2), (3,4), (4,2), and (4,3): six items. Denominator 5 is step 2.";

const LOWEST_STEP_ONE =
  "Step 1 span is 4–8 and digits stay at 1. Only seven proper fractions with a common factor fit. A wider span is step 2.";

const MIXED_STEP_ONE =
  "Step 1 span is 3–5. Whole answers are ineligible, and form_swap matches the answer for most of the rest, so the widened version holds two items (version 1 holds one). A wider span is step 2.";

export type TemplatePoolGap = {
  templateId: string;
  version: number;
  step: 1 | 2 | 3;
  reason: string;
};

export type SkillPoolGap = {
  skill: string;
  step: 1 | 2 | 3;
  reason: string;
};

/**
 * Step-1 versions that cannot reach the floor without leaving the step band,
 * plus frozen step-1 versions whose later revision does the widening.
 * Steps 2 and 3 are counted and reported. A shortfall there is not this gate.
 */
export const TEMPLATE_POOL_GAPS: readonly TemplatePoolGap[] = [
  { templateId: "add-2d-v0", version: 0, step: 1, reason: LEGACY_REASON },
  { templateId: "sub-2d-v0", version: 0, step: 1, reason: LEGACY_REASON },
  { templateId: "mul-100-v0", version: 0, step: 1, reason: LEGACY_REASON },
  { templateId: "div-100-v0", version: 0, step: 1, reason: LEGACY_REASON },
  { templateId: "mul-2d-v0", version: 0, step: 1, reason: LEGACY_REASON },
  { templateId: "div-2d-v0", version: 0, step: 1, reason: LEGACY_REASON },
  { templateId: "frac-compare-v0", version: 0, step: 1, reason: LEGACY_REASON },
  { templateId: "frac-equiv-v0", version: 0, step: 1, reason: LEGACY_REASON },
  { templateId: "frac-add-like-v0", version: 0, step: 1, reason: LEGACY_REASON },
  { templateId: "frac-add-unlike-v0", version: 0, step: 1, reason: LEGACY_REASON },
  { templateId: "frac-sub-like-v0", version: 0, step: 1, reason: LEGACY_REASON },
  { templateId: "frac-compare-larger", version: 1, step: 1, reason: COMPARE_STEP_ONE },
  { templateId: "frac-compare-smaller", version: 1, step: 1, reason: COMPARE_STEP_ONE },
  { templateId: "frac-compare-symbol", version: 1, step: 1, reason: COMPARE_STEP_ONE },
  { templateId: "frac-equiv-lowest", version: 1, step: 1, reason: LOWEST_STEP_ONE },
  { templateId: "frac-equiv-mixed", version: 1, step: 1, reason: MIXED_STEP_ONE },
  { templateId: "frac-equiv-mixed", version: 2, step: 1, reason: MIXED_STEP_ONE },
  { templateId: "frac-equiv-mixed", version: 3, step: 1, reason: MIXED_STEP_ONE },
  { templateId: "div-100-inline", version: 1, step: 1, reason: FROZEN_REASON },
  { templateId: "div-100-blank", version: 1, step: 1, reason: FROZEN_REASON },
  { templateId: "frac-equiv-scale", version: 1, step: 1, reason: FROZEN_REASON },
  { templateId: "frac-equiv-improper", version: 1, step: 1, reason: FROZEN_REASON },
];

export const SKILL_POOL_GAPS: readonly SkillPoolGap[] = [
  {
    skill: "comparing unit fractions",
    step: 1,
    reason:
      "Three step-1 templates hold 6 unequal pairs each and the seed holds 1, so the skill pool is 19. The span 2–4 band has no seventh pair. Denominator 5 is step 2.",
  },
];

export type EnginePool = {
  skill: string;
  templateId: string;
  version: number;
  step: 1 | 2 | 3;
  size: number;
};

export type SkillPool = {
  skill: string;
  step: 1 | 2 | 3;
  size: number;
};

function newestTemplates(): TemplateVersion[] {
  const newest = new Map<string, TemplateVersion>();
  for (const template of TEMPLATE_VERSIONS) {
    if (!template.active) continue;
    const current = newest.get(template.templateId);
    if (!current || template.version > current.version) newest.set(template.templateId, template);
  }
  return [...newest.values()];
}

/** Pool the engine draws, one row per template version and step. */
export function enginePools(): EnginePool[] {
  const pools: EnginePool[] = [];
  for (const template of TEMPLATE_VERSIONS) {
    for (const variant of template.spec.steps) {
      pools.push({
        skill: template.skillId,
        templateId: template.templateId,
        version: template.version,
        step: variant.assignedStep,
        size: eligibleDraws(template, variant.assignedStep).length,
      });
    }
  }
  return pools.sort((left, right) => {
    if (left.skill !== right.skill) return left.skill < right.skill ? -1 : 1;
    if (left.templateId !== right.templateId) return left.templateId < right.templateId ? -1 : 1;
    if (left.version !== right.version) return left.version - right.version;
    return left.step - right.step;
  });
}

/** Newest version of each template, summed across the skill at that step. */
export function skillStepPools(): SkillPool[] {
  const groups = new Map<string, SkillPool>();
  for (const template of newestTemplates()) {
    for (const variant of template.spec.steps) {
      const step = variant.assignedStep;
      const key = `${template.skillId}\0${step}`;
      const group = groups.get(key) ?? { skill: template.skillId, step, size: 0 };
      group.size += eligibleDraws(template, step).length;
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort((left, right) =>
    left.skill === right.skill ? left.step - right.step : left.skill < right.skill ? -1 : 1,
  );
}
