import { ITEM_CATALOG } from "@/lib/item-catalog";

/**
 * Planned length of a practice session. The first `catalogSkillCount()` slots
 * cover every skill once. The remainder is the overflow block.
 */
export const PRACTICE_SESSION_LENGTH = 15;

export function catalogSkillCount(): number {
  return ITEM_CATALOG.length;
}

/** Extra slots after one full pass of the catalog. Zero or less means no overflow block. */
export function overflowSlotCount(
  sessionLength = PRACTICE_SESSION_LENGTH,
  skillCount = catalogSkillCount(),
): number {
  return sessionLength - skillCount;
}

export function gcd(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

/**
 * Overflow steps by `overflowSlots` each session. That walk visits every skill
 * the same number of times only when the step and the catalog length are coprime.
 * A session with no overflow block does not need the check.
 */
export function assertOverflowCoprime(overflowSlots: number, skillCount: number): void {
  if (overflowSlots <= 0) return;
  if (gcd(overflowSlots, skillCount) !== 1) {
    throw new Error(
      `Practice overflow of ${overflowSlots} slots and ${skillCount} skills must be coprime.`,
    );
  }
}

function mod(value: number, count: number): number {
  return ((value % count) + count) % count;
}

/**
 * Position 0 is the lane start. Positions before `skillCount` walk the catalog
 * from that start. Later positions walk from the stored overflow offset.
 * `overflowSlots` of 0 or less keeps the lane walk for every position.
 */
export function skillIndexForPosition(
  laneStart: number,
  overflowOffset: number,
  position: number,
  skillCount = catalogSkillCount(),
  overflowSlots = overflowSlotCount(),
): number {
  if (position < skillCount || overflowSlots <= 0) {
    return mod(laneStart + position, skillCount);
  }
  return mod(overflowOffset + (position - skillCount), skillCount);
}

export function plannedCatalogIndexes(
  laneStart: number,
  overflowOffset: number,
  position: number,
  count: number,
): number[] {
  return Array.from({ length: count }, (_, slot) =>
    skillIndexForPosition(laneStart, overflowOffset, position + slot),
  );
}

/**
 * Bind four values: overflowSlots, overflowSlots, childId, skillCount.
 * The count is the child's practice_sessions rows visible to this insert.
 */
export const OVERFLOW_OFFSET_SQL = `CASE WHEN ? <= 0 THEN 0 ELSE (? * (SELECT COUNT(*) FROM practice_sessions WHERE child_id = ?)) % ? END`;
