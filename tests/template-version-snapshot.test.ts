/**
 * Template specs are immutable at a given version.
 * To change a spec, create a new version and add a new snapshot entry.
 * Do not edit content under the same version.
 */
import { describe, expect, it } from "vitest";
import { TEMPLATE_VERSIONS } from "@/lib/templates/catalog";
import { templateContentHash, templateSnapshotKey } from "@/lib/templates/hash";
import snapshot from "@/lib/template-version-snapshot.json";

describe("template version immutability", () => {
  it("matches the committed content hash for each template version", () => {
    const hashes = snapshot as Record<string, string>;
    const seen = new Set<string>();
    for (const template of TEMPLATE_VERSIONS) {
      const key = templateSnapshotKey(template);
      seen.add(key);
      expect(hashes[key], key).toBe(templateContentHash(template));
    }
    expect(Object.keys(hashes).sort()).toEqual([...seen].sort());
  });
});
