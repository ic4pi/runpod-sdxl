import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  async headers() {
    return [
      // the worker file and its manifest must always be re-checked so updates are noticed
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }, { key: "Service-Worker-Allowed", value: "/" }] },
      { source: "/precache-manifest.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
      { source: "/manifest.json", headers: [{ key: "Content-Type", value: "application/manifest+json" }] },
    ];
  },
};

export default nextConfig;
