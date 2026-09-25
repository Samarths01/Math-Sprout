import Link from "next/link";
import { interfaceCopy, type InterfaceCopyKey } from "@/lib/interface-copy";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The only practice control on the child home.
 * When practice is blocked, the button is replaced by calm copy. No second CTA.
 */
export function PracticeCta({
  childId,
  blockKey,
}: {
  childId: string;
  blockKey: InterfaceCopyKey | null;
}) {
  if (blockKey) {
    return (
      <p
        data-testid="practice-blocked"
        data-copy-key={blockKey}
        className="text-sm leading-6 text-muted-foreground"
      >
        {interfaceCopy(blockKey)}
      </p>
    );
  }

  return (
    <Link
      href={`/child/${childId}/practice`}
      data-testid="practice-cta"
      data-practice-allowed="true"
      className={cn(buttonVariants({ size: "primary" }))}
    >
      Start practice
    </Link>
  );
}
