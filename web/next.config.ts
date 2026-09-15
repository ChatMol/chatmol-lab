import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, ".."),
  serverExternalPackages: ["undici"],
  // instrumentation.ts loads undici through eval('require') so Webpack leaves
  // it alone; that also makes it invisible to file tracing, so name it here or
  // it never reaches .next/standalone and the packaged app dies on startup.
  outputFileTracingIncludes: {
    "/**": ["../node_modules/undici/**/*"],
  },
  headers: async () => [
    {
      // Prevent caching HTML pages so browsers always get fresh chunk references after deploys
      source: "/((?!_next/static|_next/image|favicon).*)",
      headers: [
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
      ],
    },
  ],
};

export default nextConfig;
