import type { ConsentViewStatus } from "@/lib/practice-gate";
import { cn } from "@/lib/utils";

const LABEL: Record<ConsentViewStatus, string> = {
  none: "Not granted",
  granted: "Granted",
  paused: "Paused",
  revoked: "Revoked",
};

const STYLE: Record<ConsentViewStatus, string> = {
  none: "bg-muted text-muted-foreground",
  granted: "bg-secondary text-secondary-foreground",
  paused: "bg-[oklch(0.94_0.06_90)] text-[oklch(0.38_0.08_70)]",
  revoked: "bg-destructive/10 text-destructive",
};

export function StatusPill({ status }: { status: ConsentViewStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium",
        STYLE[status],
      )}
    >
      Consent {LABEL[status].toLowerCase()}
    </span>
  );
}
