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

/** Text exposed to assistive tech. `aria-hidden` subtrees are skipped; `sr-only` text stays. */
function accessibleText(node: Node): string {
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  let text = "";
  node.childNodes.forEach((child) => {
    const piece = accessibleText(child);
    if (!piece) return;
    if (text && !/\s$/.test(text) && !/^\s/.test(piece)) text += " ";
    text += piece;
  });
  return text.replace(/\s+/g, " ").trim();
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
  it("announces a column stem once and keeps a visible heading on a plain item", async () => {
    await renderItem(columnItem);

    const column = document.querySelector('[data-testid="column-problem"]');
    const prompt = document.querySelector('[data-testid="practice-prompt"]');
    expect(column?.getAttribute("aria-hidden")).toBe("true");
    expect(prompt?.tagName).toBe("H2");
    expect(prompt?.classList.contains("sr-only")).toBe(true);
    expect(prompt?.textContent).toBe("20 × 3");
    const accessible = accessibleText(document.body);
    expect(accessible.match(/20 × 3/g)).toEqual(["20 × 3"]);

    await renderItem(plainItem);
    const heading = document.querySelector('[data-testid="practice-prompt"]');
    expect(document.querySelector('[data-testid="column-problem"]')).toBeNull();
    expect(heading?.tagName).toBe("H2");
    expect(heading?.classList.contains("sr-only")).toBe(false);
    expect(heading?.className).toContain("font-heading");
    expect(heading?.textContent).toBe("What is 63 - 18?");
    expect(accessibleText(document.body)).toContain("What is 63 - 18?");

    await renderItem(blankItem);
    expect(document.querySelector('[data-testid="practice-prompt"]')).toBeNull();
    expect(document.querySelector('[data-testid="inline-equation"]')?.textContent).toContain("18 +");
    expect(document.querySelector('[data-testid="inline-equation"]')?.textContent).toContain("= 30");
  });
});
