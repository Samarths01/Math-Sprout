/** Warn once if the build tag is unknown. Startup still proceeds. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { warnIfBuildUnknown } = await import("@/lib/app-build");
  warnIfBuildUnknown();
}
