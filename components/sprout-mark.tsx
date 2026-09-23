export function SproutMark({ className = "size-10" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      aria-hidden="true"
      className={className}
    >
      <rect width="48" height="48" rx="14" fill="currentColor" opacity="0.12" />
      <path
        d="M24 36V22"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M24 24c0-6 4.5-10 10-10-1 6-5 9-10 10Z"
        fill="currentColor"
      />
      <path
        d="M24 27c0-5-4-8.5-9-8.5 1 5.2 4.4 7.8 9 8.5Z"
        fill="currentColor"
        opacity="0.8"
      />
      <path
        d="M18 36h12"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
