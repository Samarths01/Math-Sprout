export const FALLBACK_TIMEZONE = "America/Los_Angeles";

export const COMMON_TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Phoenix",
  "America/Chicago",
  "America/New_York",
  "America/Anchorage",
  "Pacific/Honolulu",
] as const;

export function isValidTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function formatTimeZone(value: string): string {
  return value.replaceAll("_", " ");
}

export function timezoneFromFormValue(
  selected: string | null | undefined,
  custom: string | null | undefined,
): string | undefined {
  if (!selected || selected === "__unset__" || selected === "__default__") {
    return undefined;
  }
  if (selected === "__other__") {
    const typed = custom?.trim();
    return typed ? typed : undefined;
  }
  return selected;
}
