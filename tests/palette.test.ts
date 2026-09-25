import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flameClass, OLD_BRAND_GREEN, PALETTE, stepClass, tintOnWhite } from "@/lib/palette";

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

function channelByte(hex: string, index: number): number {
  return Number.parseInt(hex.replace("#", "").slice(index, index + 2), 16);
}

function linearize(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const red = linearize(channelByte(hex, 0));
  const green = linearize(channelByte(hex, 2));
  const blue = linearize(channelByte(hex, 4));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG 2 contrast ratio for a text color on a background color. */
function contrastRatio(text: string, background: string): number {
  const lighter = Math.max(relativeLuminance(text), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(text), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

const TEXT_ON_TINT = [
  { name: "flame-hot", text: PALETTE.flameText.hot, color: PALETTE.flame.hot },
  { name: "flame-warm", text: PALETTE.flameText.warm, color: PALETTE.flame.warm },
  { name: "flame-ember", text: PALETTE.flameText.ember, color: PALETTE.flame.ember },
  { name: "flame-resting", text: PALETTE.flameText.resting, color: PALETTE.flame.resting },
  { name: "xp", text: PALETTE.xpText, color: PALETTE.xp },
  { name: "piece", text: PALETTE.pieceText, color: PALETTE.piece },
  { name: "steady", text: PALETTE.badgeText.steady, color: PALETTE.step[2] },
  { name: "stretch", text: PALETTE.badgeText.stretch, color: PALETTE.step[4] },
] as const;

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
    expect(stepClass(5)).toBe("bg-step-4 text-white");
    expect(stepClass(9)).toBe("bg-step-5 text-white");
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

  it("keeps chip and badge text at 4.5:1 on the 12% tint", () => {
    const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8").toLowerCase();
    for (const pair of TEXT_ON_TINT) {
      const tint = tintOnWhite(pair.color);
      expect(contrastRatio(pair.text, tint), pair.name).toBeGreaterThanOrEqual(4.5);
      expect(css).toContain(pair.text.toLowerCase());
      expect(css).toContain(tint.toLowerCase());
    }
    expect(contrastRatio(PALETTE.ink, PALETTE.step[0])).toBeGreaterThanOrEqual(4.5);
    expect(PALETTE.destructive).toBe("#B3261E");
    expect(PALETTE.destructive).not.toBe(PALETTE.verdict.miss);
    expect(contrastRatio(PALETTE.destructive, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(PALETTE.destructive, PALETTE.paper)).toBeGreaterThanOrEqual(4.5);
    expect(css).toContain(`--destructive: ${PALETTE.destructive.toLowerCase()}`);
  });
});
