/**
 * Plain props for the client fuel strip.
 * The server fills every field. This file imports nothing.
 */
export type FuelStripView = {
  childId: string;
  text: string;
  xp: number;
  dayCount: number | null;
  pieces: number;
  goal: number;
  flame: "start" | "resting" | "lit";
  heat?: "hot" | "warm" | "ember" | "dormant";
  sourceEventId: string | null;
  forcePulse?: boolean;
};
