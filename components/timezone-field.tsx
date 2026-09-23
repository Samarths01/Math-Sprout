"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  COMMON_TIMEZONES,
  formatTimeZone,
  isValidTimeZone,
  timezoneFromFormValue,
} from "@/lib/timezones";

const UNSET = "__unset__";
const DEFAULT = "__default__";
const OTHER = "__other__";

function initialChoice(mode: "guardian" | "child") {
  return mode === "child" ? DEFAULT : UNSET;
}

function subscribeToTimezone() {
  return () => {};
}

function readBrowserTimeZone() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone ?? "";
}

export function TimezoneField({
  id,
  mode,
  onChange,
}: {
  id: string;
  mode: "guardian" | "child";
  onChange?: (value: string | undefined) => void;
}) {
  const [choice, setChoice] = useState(() => initialChoice(mode));
  const [custom, setCustom] = useState("");
  const detected = useSyncExternalStore(
    subscribeToTimezone,
    readBrowserTimeZone,
    () => "",
  );
  const extraDetected =
    detected &&
    isValidTimeZone(detected) &&
    !COMMON_TIMEZONES.includes(detected as (typeof COMMON_TIMEZONES)[number])
      ? detected
      : null;

  useEffect(() => {
    onChange?.(timezoneFromFormValue(choice, custom));
  }, [choice, custom, onChange]);

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>Timezone</Label>
      <select
        id={id}
        value={choice}
        onChange={(event) => setChoice(event.target.value)}
        className="h-11 w-full rounded-lg border border-input bg-card px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
      >
        {mode === "child" ? (
          <option value={DEFAULT}>
            Use my timezone, or Los Angeles if I have not set one
          </option>
        ) : (
          <option value={UNSET}>
            Don&apos;t set one (children default to Los Angeles)
          </option>
        )}
        {extraDetected ? (
          <option value={extraDetected}>{formatTimeZone(extraDetected)}</option>
        ) : null}
        {COMMON_TIMEZONES.map((zone) => (
          <option key={zone} value={zone}>
            {formatTimeZone(zone)}
          </option>
        ))}
        <option value={OTHER}>Other IANA timezone</option>
      </select>
      {choice === OTHER ? (
        <Input
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="America/Los_Angeles"
          aria-label="IANA timezone"
          className="h-11"
          autoComplete="off"
        />
      ) : null}
      <p className="text-sm text-muted-foreground">
        {mode === "child"
          ? "Saved on the child profile. The server fills this in when you leave the default selected."
          : "Saved on your parent account and used as the default for new children."}
      </p>
    </div>
  );
}
