import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ladon/core"],
  poweredByHeader: false,
};

export default nextConfig;
