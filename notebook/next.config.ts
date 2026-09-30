import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["pg", "unpdf", "mammoth", "tesseract.js", "@napi-rs/canvas"],
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
};

export default config;
