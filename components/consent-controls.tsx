"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  statusForAction,
  type ConsentAction,
  type ConsentViewStatus,
} from "@/lib/practice-gate";
import { Button } from "@/components/ui/button";

const ACTIONS: { action: ConsentAction; label: string }[] = [
  { action: "grant", label: "Grant" },
  { action: "pause", label: "Pause" },
  { action: "revoke", label: "Revoke" },
];

export function ConsentControls({
  childId,
  status,
}: {
  childId: string;
  status: ConsentViewStatus;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<ConsentAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function update(action: ConsentAction) {
    setPending(action);
    setError(null);
    try {
      const response = await fetch(`/api/children/${childId}/consent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        setError(data?.error ?? "Could not update consent.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach Math Sprout. Check your connection and try again.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map(({ action, label }) => {
          const selected = status === statusForAction(action);
          return (
            <Button
              key={action}
              type="button"
              variant={
                selected
                  ? action === "revoke"
                    ? "destructive"
                    : "default"
                  : "outline"
              }
              aria-pressed={selected}
              disabled={pending !== null}
              className="h-10"
              onClick={() => update(action)}
            >
              {pending === action ? "Saving…" : label}
            </Button>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
