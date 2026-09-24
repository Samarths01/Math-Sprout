/** Drawn fuel marks. They take the chip color via currentColor. */

export function FlameMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8.2 1.2c.3 2-.7 3.2-1.7 4.2C5.2 6.7 4.4 7.8 4.4 9.3 4.4 12 6.2 14.2 8.6 14.2s4.2-2.2 4.2-4.8c0-1.7-.9-2.8-2-4-.3 1.3-1.3 1.9-2.1.7.3-1.9.7-3.5-.5-4.9z"
      />
    </svg>
  );
}

export function StarMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" aria-hidden="true">
      <path
        fill="currentColor"
        d="m8 1.4 1.7 3.9 4.2.5-3.1 2.9.9 4.2L8 10.9 4.3 13l.9-4.2L2.1 5.8l4.2-.5z"
      />
    </svg>
  );
}

/** One jigsaw piece: body, top knob, side socket. Not the old bow-tie mark. */
export function PieceMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" aria-hidden="true">
      <path
        fill="currentColor"
        d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"
      />
    </svg>
  );
}
