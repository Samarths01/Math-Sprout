import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  // The dev server blocks hydration from 127.0.0.1 unless it is listed here.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
