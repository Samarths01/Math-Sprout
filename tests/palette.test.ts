import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flameClass, OLD_BRAND_GREEN, PALETTE, stepClass } from "@/lib/palette";

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...filesUnder(full));
      continue;
    }
    if (/\.(tsx|css)$/.test(entry)) out.push(full);
  }
  return out;
}

function isGreenHex(hex: string): boolean {
  const raw = hex.replace("#", "");
  const expanded =
    raw.length === 3
      ? raw
          .split("")
          .map((char) => char + char)
          .join("")
      : raw;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  return green > red + 15 && green > blue + 15 && green > 70;
}

describe("shared palette", () => {
  it("maps server heat states and darkens each difficulty step", () => {
    expect(flameClass("hot")).toBe("text-flame-hot");
    expect(flameClass("warm")).toBe("text-flame-warm");
    expect(flameClass("ember")).toBe("text-flame-ember");
    expect(flameClass("dormant")).toBe("text-flame-resting");
    expect(stepClass(2)).toBe("bg-step-1 text-foreground");
    expect(stepClass(3)).toBe("bg-step-2 text-foreground");
    expect(stepClass(4)).toBe("bg-step-3 text-foreground");
    expect(stepClass(9)).toBe("bg-step-5 text-foreground");
    expect(PALETTE.verdict.correct).toBe(PALETTE.logo);
    expect(PALETTE.ink).not.toBe(PALETTE.verdict.correct);
  });

  it("fails when a component uses a raw green or the old brand green", () => {
    const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8").toLowerCase();
    expect(css).toContain(`--primary: ${PALETTE.ink.toLowerCase()}`);
    expect(css).toContain(`--flame-hot: ${PALETTE.flame.hot.toLowerCase()}`);
    expect(css).toContain(`--flame-warm: ${PALETTE.flame.warm.toLowerCase()}`);
    expect(css).toContain(`--flame-ember: ${PALETTE.flame.ember.toLowerCase()}`);
    expect(css).toContain(`--flame-resting: ${PALETTE.flame.resting.toLowerCase()}`);
    expect(css).toContain(`--xp: ${PALETTE.xp.toLowerCase()}`);
    expect(css).toContain(`--piece: ${PALETTE.piece.toLowerCase()}`);
    expect(css).toContain(`--verdict-correct: ${PALETTE.verdict.correct.toLowerCase()}`);
    expect(css).toContain(`--verdict-miss: ${PALETTE.verdict.miss.toLowerCase()}`);
    expect(css).toContain(`--logo: ${PALETTE.logo.toLowerCase()}`);
    expect(css).not.toContain(OLD_BRAND_GREEN);

    const roots = ["components", "app"].map((dir) => path.join(process.cwd(), dir));
    const offenders: string[] = [];
    for (const file of roots.flatMap((dir) => filesUnder(dir))) {
      if (file.endsWith(`${path.sep}globals.css`)) continue;
      const source = readFileSync(file, "utf8");
      const relative = path.relative(process.cwd(), file);
      if (source.includes(OLD_BRAND_GREEN)) offenders.push(`${relative} old brand green`);
      if (/oklch\([^)]*\b1[0-6]\d(?:\s*\)|\s*\/)/.test(source)) {
        offenders.push(`${relative} green oklch`);
      }
      if (/\b(?:bg|text|border|fill|stroke|ring)-(?:green|emerald|lime|teal)-\d/.test(source)) {
        offenders.push(`${relative} tailwind green`);
      }
      for (const match of source.matchAll(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) {
        if (isGreenHex(match[0])) offenders.push(`${relative} ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
