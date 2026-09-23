/** Calendar helpers on `child.timezone`. Qualifying days are local dates, not UTC dates. */

function part(
  utc: Date,
  timeZone: string,
  type: Intl.DateTimeFormatPartTypes,
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(utc);
  return parts.find((item) => item.type === type)?.value ?? "0";
}

function timeZoneOffsetMs(utc: Date, timeZone: string): number {
  const year = Number(part(utc, timeZone, "year"));
  const month = Number(part(utc, timeZone, "month"));
  const day = Number(part(utc, timeZone, "day"));
  let hour = Number(part(utc, timeZone, "hour"));
  const minute = Number(part(utc, timeZone, "minute"));
  const second = Number(part(utc, timeZone, "second"));
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - utc.getTime();
}

export function localDate(iso: string, timeZone: string): string {
  const utc = new Date(iso);
  const year = part(utc, timeZone, "year");
  const month = part(utc, timeZone, "month");
  const day = part(utc, timeZone, "day");
  return `${year}-${month}-${day}`;
}

export function addCalendarDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const nextYear = shifted.getUTCFullYear();
  const nextMonth = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const nextDay = String(shifted.getUTCDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

export function calendarDaysBetween(fromDay: string, toDay: string): number {
  const [fromYear, fromMonth, fromDayOfMonth] = fromDay.split("-").map(Number);
  const [toYear, toMonth, toDayOfMonth] = toDay.split("-").map(Number);
  const from = Date.UTC(fromYear, fromMonth - 1, fromDayOfMonth);
  const to = Date.UTC(toYear, toMonth - 1, toDayOfMonth);
  return Math.round((to - from) / 86_400_000);
}

export function startOfLocalDay(ymd: string, timeZone: string): Date {
  const [year, month, day] = ymd.split("-").map(Number);
  let utc = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = timeZoneOffsetMs(new Date(utc), timeZone);
    const next = Date.UTC(year, month - 1, day, 0, 0, 0) - offset;
    if (next === utc) break;
    utc = next;
  }
  return new Date(utc);
}

/** Ember lasts through the next local calendar day and ends as that day ends. */
export function emberExpiryForQualifyingDay(qualifyingDay: string, timeZone: string): string {
  return startOfLocalDay(addCalendarDays(qualifyingDay, 2), timeZone).toISOString();
}

export function mondayOf(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return addCalendarDays(ymd, -daysSinceMonday);
}

/** Local Monday 00:00 inclusive through the next Monday 00:00 exclusive, as UTC instants. */
export function localWeekRange(
  iso: string,
  timeZone: string,
): { startIso: string; endIso: string } {
  const monday = mondayOf(localDate(iso, timeZone));
  return {
    startIso: startOfLocalDay(monday, timeZone).toISOString(),
    endIso: startOfLocalDay(addCalendarDays(monday, 7), timeZone).toISOString(),
  };
}
