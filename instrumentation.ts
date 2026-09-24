/** Prime the build tag in the background, then warn once if it is still unknown. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { primeAppBuildSha, warnIfBuildUnknown } = await import("@/lib/app-build");
  void primeAppBuildSha().then(() => {
    warnIfBuildUnknown();
  });
}
