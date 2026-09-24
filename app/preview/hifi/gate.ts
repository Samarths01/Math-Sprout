/** Dev-only hi-fi route. Production renders nothing. */
export function hifiPreviewAllowed(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv !== "production";
}
