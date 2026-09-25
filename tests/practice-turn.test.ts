// @vitest-environment happy-dom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PracticeSession } from "@/components/practice-session";
import { XP_AMOUNT, type AttemptResult, type PublicItem } from "@/lib/attempt-contract";

const columnItem: PublicItem = {
  id: "ops-g2-add",
  pack: "operations",
  grade: 2,
  skill: "adding two-digit numbers",
  prompt: "15 + 34",
  stepWord: "Warm-up",
  itemInstanceId: "instance-column",
  layout: "column",
  columnLines: ["  15", "+ 34"],
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

const followUpItem: PublicItem = {
  id: "ops-g2-add",
  pack: "operations",
  grade: 2,
  skill: "adding two-digit numbers",
  prompt: "What is 20 + 4?",
  stepWord: "Steady",
  itemInstanceId: "instance-follow-up",
  layout: "inline",
  answerKind: "whole",
};

const items = [columnItem, plainItem, followUpItem];

function attemptResult(idempotencyKey: string, current: PublicItem, nextItem: PublicItem): AttemptResult {
  return {
    attemptId: `attempt-${idempotencyKey}`,
    idempotencyKey,
    replayed: false,
    correct: false,
    whatWentWell: "You committed to an answer.",
    oneFocus: "Line the places up.",
    tryNext: "Try the next one.",
    lockIn: `${current.prompt} = 49`,
    celebrationTier: "quietXp",
    lane: "review",
    flags: [],
    eventIds: ["qe-1"],
    xpAmount: XP_AMOUNT.quietXp,
    fuel: { credit: XP_AMOUNT.quietXp, heatEventId: null, pieceEventIds: [] },
    clientView: {
      bandLabel: "Still learning",
      showConceptChip: true,
      celebrationTier: "quietXp",
    },
    nextItem,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const capReleases: Array<() => void> = [];

function holdCap(): Promise<void> {
  return new Promise((resolve) => {
    capReleases.push(resolve);
  });
}

let itemIndex = 0;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function installFetch() {
  itemIndex = 0;
  capReleases.length = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  window.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/sessions") && init?.method === "POST") {
      return json({
        sessionId: "session-1",
        item: items[0],
        lane: "recommended",
        atBoundary: false,
        clientView: null,
      });
    }
    if (url.endsWith("/attempts") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { idempotencyKey: string };
      const current = items[itemIndex] ?? items[items.length - 1];
      const next = items[itemIndex + 1] ?? followUpItem;
      itemIndex += 1;
      return json(attemptResult(body.idempotencyKey, current, next));
    }
    if (url.endsWith("/offline-cap") && init?.method === "POST") {
      await holdCap();
      return json({ ok: true });
    }
    return json({});
  };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(check: () => void) {
  let last: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      last = error;
      await settle();
    }
  }
  throw last;
}

function answerInput(): HTMLInputElement {
  const input = document.querySelector('[data-testid="practice-answer"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("answer input missing");
  }
  return input;
}

function expectFreshAnswer(stem: string) {
  expect(document.querySelector('[data-testid="verdict-strip"]')).toBeNull();
  expect(document.querySelector('[data-testid="practice-feedback"]')).toBeNull();
  const input = answerInput();
  expect(input.value).toBe("");
  expect(input.disabled).toBe(false);
  expect(document.body.textContent).toContain(stem);
  expect(document.body.textContent).not.toContain("Not yet");
}

async function typeAnswer(value: string) {
  const input = answerInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function checkAnswer() {
  await act(async () => {
    const button = document.querySelector('[data-testid="practice-submit"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error("Check answer missing");
    button.click();
  });
  await waitFor(() => {
    if (!document.querySelector('[data-testid="verdict-strip"]')) {
      throw new Error("result card did not appear");
    }
  });
}

async function nextProblem() {
  await act(async () => {
    const button = [...document.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Next problem"),
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error("Next problem missing");
    button.click();
  });
  const release = capReleases.shift();
  if (!release) throw new Error("offline-cap was not in flight");
  await act(async () => {
    release();
  });
  await settle();
}

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  capReleases.splice(0).forEach((release) => release());
});

describe("practice answer state follows the item instance", () => {
  it("shows a fresh empty answer after Next on a column item and a plain item", async () => {
    installFetch();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(PracticeSession, { childId: "child-1", displayName: "Ada" }),
      );
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="column-problem"]')?.textContent).toContain("15");
    });

    expectFreshAnswer("15");
    expect(document.querySelector('[data-testid="column-problem"]')).not.toBeNull();

    await typeAnswer("1");
    await checkAnswer();
    expect(document.querySelector('[data-testid="verdict-strip"]')?.textContent).toContain("Not yet");
    expect(document.body.textContent).toContain("15 + 34 = 49");

    await nextProblem();
    expect(document.querySelector('[data-testid="column-problem"]')).toBeNull();
    expect(document.querySelector('[data-testid="practice-prompt"]')?.textContent).toBe(
      "What is 63 - 18?",
    );
    expectFreshAnswer("What is 63 - 18?");

    await typeAnswer("2");
    await checkAnswer();
    expect(document.body.textContent).toContain("What is 63 - 18? = 49");

    await nextProblem();
    expect(document.querySelector('[data-testid="practice-prompt"]')?.textContent).toBe(
      "What is 20 + 4?",
    );
    expectFreshAnswer("What is 20 + 4?");
  });
});
