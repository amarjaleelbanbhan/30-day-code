import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["pg", "unpdf", "mammoth"],
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
};

export default config;
