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

export function PieceMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6 1.5h2.2c.2.9.9 1.5 1.8 1.5s1.6-.6 1.8-1.5H14v2.2c-.9.2-1.5.9-1.5 1.8S13.1 7.3 14 7.5V12H9.5c-.2-.9-.9-1.5-1.8-1.5s-1.6.6-1.8 1.5H2V7.3c.9-.2 1.5-.9 1.5-1.8S2.9 3.9 2 3.7V1.5h4z"
      />
    </svg>
  );
}
