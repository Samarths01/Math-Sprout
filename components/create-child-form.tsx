"use client";

import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { TimezoneField } from "@/components/timezone-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatTimeZone } from "@/lib/timezones";

export function CreateChildForm({
  guardianTimezone,
}: {
  guardianTimezone: string | null;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [timezone, setTimezone] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const onTimezone = useCallback((value: string | undefined) => {
    setTimezone(value);
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/children", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName,
          ...(timezone ? { timezone } : {}),
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        setError(data?.error ?? "Could not add this child.");
        return;
      }
      router.push("/parent");
      router.refresh();
    } catch {
      setError("Could not reach Math Sprout. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="displayName">Child&apos;s name</Label>
        <Input
          id="displayName"
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          autoComplete="off"
          className="h-11"
          placeholder="Ava"
        />
      </div>
      <TimezoneField id="child-timezone" mode="child" onChange={onTimezone} />
      <p className="text-sm text-muted-foreground">
        {guardianTimezone
          ? `Your account timezone is ${formatTimeZone(guardianTimezone)}.`
          : "Your account has no timezone, so the default is America/Los Angeles."}{" "}
        Consent starts as not granted. Practice stays closed until you grant it.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="h-11">
        {pending ? "Saving…" : "Save child profile"}
      </Button>
    </form>
  );
}
