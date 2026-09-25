/**
 * Template specs are immutable at a given version.
 * To change a spec or a pool count, create a new version and add a new snapshot entry.
 * Do not edit the hash or the pool counts under the same version.
 */
import { describe, expect, it } from "vitest";
import { TEMPLATE_VERSIONS } from "@/lib/templates/catalog";
import { eligibleDraws } from "@/lib/templates/engine";
import { templateContentHash, templateSnapshotKey } from "@/lib/templates/hash";
import snapshot from "@/lib/template-version-snapshot.json";

type SnapshotEntry = { hash: string; pools: Record<string, number> };

describe("template version immutability", () => {
  it("matches the committed content hash and pool counts for each template version", () => {
    const entries = snapshot as Record<string, SnapshotEntry>;
    const seen = new Set<string>();
    for (const template of TEMPLATE_VERSIONS) {
      const key = templateSnapshotKey(template);
      seen.add(key);
      const entry = entries[key];
      expect(entry?.hash, key).toBe(templateContentHash(template));
      const pools: Record<string, number> = {};
      for (const variant of template.spec.steps) {
        pools[String(variant.assignedStep)] = eligibleDraws(template, variant.assignedStep).length;
      }
      expect(entry?.pools, key).toEqual(pools);
    }
    expect(Object.keys(entries).sort()).toEqual([...seen].sort());
  });
});
