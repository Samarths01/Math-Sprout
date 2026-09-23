import type { ReactNode } from "react";

export function Shell({
  children,
  width = "wide",
}: {
  children: ReactNode;
  width?: "wide" | "narrow";
}) {
  return (
    <div
      className={
        width === "narrow"
          ? "mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10"
          : "mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10"
      }
    >
      {children}
    </div>
  );
}
