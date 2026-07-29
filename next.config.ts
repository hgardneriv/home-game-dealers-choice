import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // A stray lockfile in the home directory confuses root inference.
    root: __dirname,
  },
};

export default nextConfig;
