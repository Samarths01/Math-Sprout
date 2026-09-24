import { APP_BUILD_SHA } from "@/lib/app-build";

/** Resolve the build tag once, before the server accepts requests. */
export function register() {
  if (APP_BUILD_SHA.trim().length === 0) {
    throw new Error("App build tag resolved empty.");
  }
}
