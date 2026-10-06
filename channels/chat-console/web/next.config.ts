import path from "node:path";
import type { NextConfig } from "next";

/**
 * The console server owns routing and auth, so the app ships as a static
 * export it serves from `web/out` beside its own API.
 */
const nextConfig: NextConfig = {
  output: "export",
  /** This app has its own lockfile inside the harness repo, so pin the root. */
  turbopack: { root: path.dirname(new URL(import.meta.url).pathname) },
  images: { unoptimized: true },
  devIndicators: false
};

export default nextConfig;
