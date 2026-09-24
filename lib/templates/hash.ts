import { createHash } from "node:crypto";
import type { TemplateVersion } from "@/lib/templates/types";

/** Stable JSON: object keys are sorted, array order is preserved. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/**
 * Content identity of a template spec.
 * Version, provenance, evidence eligibility, and parent prior are not part of
 * the hash. A content change requires a new version.
 */
export function templateContentHash(template: TemplateVersion): string {
  const payload = {
    templateId: template.templateId,
    skillId: template.skillId,
    promptShape: template.promptShape,
    spec: template.spec,
    bugRules: template.bugRules,
    defaultFocus: template.defaultFocus ?? null,
    whyItWorks: template.whyItWorks ?? null,
    requireForm: template.requireForm ?? null,
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function templateSnapshotKey(template: Pick<TemplateVersion, "templateId" | "version">): string {
  return `${template.templateId}@${template.version}`;
}
