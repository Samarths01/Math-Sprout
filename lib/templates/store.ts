import type Database from "better-sqlite3";
import { TEMPLATE_VERSIONS } from "@/lib/templates/catalog";
import { templateContentHash } from "@/lib/templates/hash";
import type { TemplateSpec, TemplateVersion } from "@/lib/templates/types";

/**
 * Columns issuance is allowed to read from a template version.
 * Parent prior is intentionally absent. Issuance filters on assigned_step
 * inside the spec, never on parent_prior_grade or parent_prior_difficulty.
 */
export const ISSUANCE_TEMPLATE_COLUMNS = [
  "template_id",
  "template_version",
  "skill_id",
  "prompt_shape",
  "spec_json",
  "bug_rules_json",
  "default_focus",
  "why_it_works",
  "require_form",
  "evidence_eligible",
  "active",
] as const;

export function issuanceTemplateSelect(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return ISSUANCE_TEMPLATE_COLUMNS.map((column) => `${prefix}${column}`).join(", ");
}

const TEMPLATE_DDL = `
CREATE TABLE IF NOT EXISTS item_template_versions (
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  skill_id TEXT NOT NULL,
  prompt_shape TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  bug_rules_json TEXT NOT NULL,
  default_focus TEXT,
  why_it_works TEXT,
  require_form TEXT CHECK (
    require_form IS NULL OR require_form IN ('lowest_terms', 'mixed', 'improper')
  ),
  provenance TEXT NOT NULL CHECK (provenance IN ('seed', 'parent', 'ai_assisted')),
  evidence_eligible INTEGER NOT NULL CHECK (evidence_eligible IN (0, 1)),
  parent_prior_grade INTEGER,
  parent_prior_difficulty TEXT CHECK (
    parent_prior_difficulty IS NULL
    OR parent_prior_difficulty IN ('easy', 'medium', 'hard')
  ),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  promoted INTEGER NOT NULL DEFAULT 1 CHECK (promoted IN (0, 1)),
  content_hash TEXT NOT NULL,
  PRIMARY KEY (template_id, template_version)
);

CREATE TABLE IF NOT EXISTS item_instances (
  item_instance_id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  difficulty_step INTEGER NOT NULL,
  operands_json TEXT NOT NULL,
  operand_key TEXT NOT NULL,
  canonical_answer TEXT NOT NULL,
  answer_line TEXT NOT NULL,
  prompt TEXT NOT NULL,
  presentation_json TEXT NOT NULL,
  evidence_eligible INTEGER NOT NULL CHECK (evidence_eligible IN (0, 1)),
  repeat_forced INTEGER NOT NULL CHECK (repeat_forced IN (0, 1)),
  issue_idempotency_key TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_attempt_key TEXT,
  require_form TEXT,
  compare_mode TEXT NOT NULL,
  bug_hits_json TEXT NOT NULL,
  default_focus TEXT,
  why_it_works TEXT,
  UNIQUE (session_id, issue_idempotency_key)
);

CREATE INDEX IF NOT EXISTS item_instances_child_issued
  ON item_instances(child_id, issued_at);
CREATE INDEX IF NOT EXISTS item_instances_child_template
  ON item_instances(child_id, template_id, operand_key);

CREATE TABLE IF NOT EXISTS answer_format_rejects (
  id TEXT PRIMARY KEY,
  item_instance_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('seed', 'parent', 'ai_assisted')),
  prompt_type TEXT NOT NULL,
  answer_type TEXT NOT NULL,
  rejected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS answer_format_rejects_version
  ON answer_format_rejects(template_version, provenance, prompt_type);
`;

function addAttemptColumn(db: Database.Database, name: string, ddl: string): void {
  const columns = new Set(
    (db.pragma("table_info(attempts)") as Array<{ name: string }>).map((row) => row.name),
  );
  if (columns.size === 0 || columns.has(name)) return;
  db.exec(`ALTER TABLE attempts ADD COLUMN ${ddl}`);
}

export function migrateItemTemplates(db: Database.Database): void {
  db.exec(TEMPLATE_DDL);
  addAttemptColumn(db, "item_instance_id", "item_instance_id TEXT");
  addAttemptColumn(db, "template_id", "template_id TEXT");
  addAttemptColumn(db, "difficulty_step", "difficulty_step INTEGER");
  addAttemptColumn(db, "estimator_evidence", "estimator_evidence INTEGER");
  const count = db.prepare(`SELECT COUNT(*) AS count FROM item_template_versions`).get() as {
    count: number;
  };
  if (count.count === 0) seedTemplateVersions(db);
}

export function seedTemplateVersions(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO item_template_versions (
       template_id, template_version, skill_id, prompt_shape, spec_json, bug_rules_json,
       default_focus, why_it_works, require_form, provenance, evidence_eligible,
       parent_prior_grade, parent_prior_difficulty, active, promoted, content_hash
     ) VALUES (
       @template_id, @template_version, @skill_id, @prompt_shape, @spec_json, @bug_rules_json,
       @default_focus, @why_it_works, @require_form, @provenance, @evidence_eligible,
       @parent_prior_grade, @parent_prior_difficulty, @active, @promoted, @content_hash
     )`,
  );
  const write = db.transaction((templates: TemplateVersion[]) => {
    for (const template of templates) insert.run(templateRow(template));
  });
  write(TEMPLATE_VERSIONS);
}

function templateRow(template: TemplateVersion) {
  return {
    template_id: template.templateId,
    template_version: template.version,
    skill_id: template.skillId,
    prompt_shape: template.promptShape,
    spec_json: JSON.stringify(template.spec),
    bug_rules_json: JSON.stringify(template.bugRules),
    default_focus: template.defaultFocus ?? null,
    why_it_works: template.whyItWorks ?? null,
    require_form: template.requireForm ?? null,
    provenance: template.provenance,
    evidence_eligible: template.evidenceEligible ? 1 : 0,
    parent_prior_grade: template.parentPriorGrade,
    parent_prior_difficulty: template.parentPriorDifficulty,
    active: template.active ? 1 : 0,
    promoted: template.promoted ? 1 : 0,
    content_hash: templateContentHash(template),
  };
}

export type IssuanceTemplateRow = {
  template_id: string;
  template_version: number;
  skill_id: string;
  prompt_shape: string;
  spec_json: string;
  bug_rules_json: string;
  default_focus: string | null;
  why_it_works: string | null;
  require_form: TemplateVersion["requireForm"] | null;
  evidence_eligible: number;
  active: number;
};

export function parseIssuanceTemplate(row: IssuanceTemplateRow): TemplateVersion {
  const spec = JSON.parse(row.spec_json) as TemplateSpec;
  return {
    templateId: row.template_id,
    version: row.template_version,
    skillId: row.skill_id,
    promptShape: row.prompt_shape,
    spec,
    bugRules: JSON.parse(row.bug_rules_json) as TemplateVersion["bugRules"],
    ...(row.default_focus ? { defaultFocus: row.default_focus } : {}),
    ...(row.why_it_works ? { whyItWorks: row.why_it_works } : {}),
    ...(row.require_form ? { requireForm: row.require_form } : {}),
    provenance: "seed",
    evidenceEligible: row.evidence_eligible === 1,
    parentPriorGrade: null,
    parentPriorDifficulty: null,
    active: row.active === 1,
    promoted: true,
  };
}
