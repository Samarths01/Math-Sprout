// @vitest-environment happy-dom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PracticeProblem } from "@/components/practice-problem";
import type { PublicItem } from "@/lib/attempt-contract";

const columnItem: PublicItem = {
  id: "ops-g3-mul",
  pack: "operations",
  grade: 3,
  skill: "multiplying by a one-digit number",
  prompt: "20 × 3",
  stepWord: "Warm-up",
  itemInstanceId: "instance-column",
  layout: "column",
  columnLines: ["  20", "×  3"],
  answerKind: "whole",
};

const plainItem: PublicItem = {
  id: "ops-g2-add",
  pack: "operations",
  grade: 2,
  skill: "adding two-digit numbers",
  prompt: "What is 63 - 18?",
  stepWord: "Warm-up",
  itemInstanceId: "instance-plain",
  layout: "inline",
  answerKind: "whole",
};

const blankItem: PublicItem = {
  id: "ops-g2-add",
  pack: "operations",
  grade: 2,
  skill: "adding two-digit numbers",
  prompt: "18 + __ = 30",
  stepWord: "Warm-up",
  itemInstanceId: "instance-blank",
  layout: "inline",
  blankInline: { leading: "18 +", trailing: "= 30" },
  answerKind: "whole",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function visibleText(node: ParentNode): string {
  const clone = node.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".sr-only").forEach((hidden) => hidden.remove());
  return clone.textContent ?? "";
}

function unmount() {
  const mounted = root;
  const node = container;
  root = null;
  container = null;
  if (mounted) {
    act(() => {
      mounted.unmount();
    });
  }
  node?.remove();
}

async function renderItem(item: PublicItem) {
  unmount();
  const node = document.createElement("div");
  document.body.appendChild(node);
  container = node;
  const mounted = createRoot(node);
  root = mounted;
  await act(async () => {
    mounted.render(createElement(PracticeProblem, { item }));
  });
}

afterEach(() => {
  unmount();
});

describe("practice problem stem", () => {
  it("shows a column stem visually once and keeps the heading on a plain item", async () => {
    await renderItem(columnItem);

    const column = document.querySelector('[data-testid="column-problem"]');
    const prompt = document.querySelector('[data-testid="practice-prompt"]');
    expect(column).not.toBeNull();
    expect(column?.textContent).toBe("  20\n×  3");
    expect(column?.classList.contains("sr-only")).toBe(false);
    expect(column?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelectorAll('[data-testid="column-problem"]')).toHaveLength(1);
    expect(prompt?.tagName).toBe("H2");
    expect(prompt?.classList.contains("sr-only")).toBe(true);
    expect(prompt?.textContent).toBe("20 × 3");
    expect(visibleText(document.body)).not.toContain("20 × 3");
    expect(visibleText(document.body)).toContain("20");
    expect(visibleText(document.body)).toContain("×  3");

    await renderItem(plainItem);
    const heading = document.querySelector('[data-testid="practice-prompt"]');
    expect(document.querySelector('[data-testid="column-problem"]')).toBeNull();
    expect(heading?.tagName).toBe("H2");
    expect(heading?.classList.contains("sr-only")).toBe(false);
    expect(heading?.textContent).toBe("What is 63 - 18?");
    expect(visibleText(document.body)).toContain("What is 63 - 18?");

    await renderItem(blankItem);
    expect(document.querySelector('[data-testid="practice-prompt"]')).toBeNull();
    expect(document.querySelector('[data-testid="inline-equation"]')?.textContent).toContain("18 +");
    expect(document.querySelector('[data-testid="inline-equation"]')?.textContent).toContain("= 30");
  });
});
