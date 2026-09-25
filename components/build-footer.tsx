/** Muted build tag. The parent page passes the cached label. Render does not resolve git. */
export function ParentBuildFooter({ label }: { label: string }) {
  return (
    <p data-testid="parent-build-footer" className="text-xs text-muted-foreground">
      {label}
    </p>
  );
}
