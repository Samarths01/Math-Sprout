import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { Shell } from "@/components/shell";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function NotFound() {
  return (
    <Shell width="narrow">
      <AppHeader eyebrow="Not found" />
      <div className="grid gap-3">
        <h1 className="font-heading text-3xl">That page is not here</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          The child profile may belong to another parent, or the link is out of date.
        </p>
        <Link href="/parent" className={cn(buttonVariants({}), "h-11 w-fit px-4")}>
          Go to parent home
        </Link>
      </div>
    </Shell>
  );
}
