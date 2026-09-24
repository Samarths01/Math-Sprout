import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hifiPreviewAllowed } from "@/app/preview/hifi/gate";

describe("hi-fi preview", () => {
  it("stays off in production and does not touch the server", () => {
    expect(hifiPreviewAllowed("production")).toBe(false);
    expect(hifiPreviewAllowed("development")).toBe(true);
    expect(hifiPreviewAllowed("test")).toBe(true);
    const page = readFileSync(path.join(process.cwd(), "app/preview/hifi/page.tsx"), "utf8");
    expect(page).toContain("notFound()");
    expect(page).toContain("hifiPreviewAllowed()");
    const frames = readFileSync(path.join(process.cwd(), "app/preview/hifi/frames.tsx"), "utf8");
    expect(frames).not.toMatch(/getDb|submitAttempt|qualifying-bus|from "@\/lib\/fuel"|from "@\/lib\/build-goal"/);
    expect(frames).toContain('fuelText="4-day flame · 120 · 2/5"');
    expect(frames).toContain("Not yet");
    expect(frames).toContain("Flame resting");
  });
});
