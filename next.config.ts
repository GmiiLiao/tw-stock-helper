import type { NextConfig } from "next";
import { execSync } from "node:child_process";

// build 時注入部署身分，供 /api/system/version 回報（沒有 git 時回 null，不捏造）
function gitSha(): string {
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return ""; }
}

const nextConfig: NextConfig = {
  env: {
    GIT_SHA: gitSha(),
    BUILD_AT: new Date().toISOString(),
  },
};

export default nextConfig;
