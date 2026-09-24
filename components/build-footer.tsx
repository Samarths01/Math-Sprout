import { currentAppBuildSha, formatParentBuildLabel } from "@/lib/app-build";

/** Muted build tag. Rendered on the parent home only. */
export function ParentBuildFooter() {
  return (
    <p data-testid="parent-build-footer" className="text-xs text-muted-foreground">
      {formatParentBuildLabel(currentAppBuildSha())}
    </p>
  );
}
