import type { NextConfig } from "next";
import { execSync } from "node:child_process";

// 會進 build 產物的路徑：這些地方有未提交（含未追蹤）的修改時，部署身分加 -dirty（2026-10-04·WM-SCAN G4-05）——
// 否則從髒樹 build 的線上 sha 仍等於 HEAD，「sha＝HEAD 才可宣稱已部署」會假陽性。
const BUILD_PATHS = ["src", "public", "package.json", "package-lock.json", "next.config.ts", "tsconfig.json"];

// build 時注入部署身分，供 /api/system/version 回報（沒有 git 時回 null，不捏造）
function gitSha(): string {
  let sha = "";
  try { sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return ""; }
  try {
    const dirty = execSync(`git status --porcelain --untracked-files=normal -- ${BUILD_PATHS.join(" ")}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return `${sha}-unknown`;   // 讀不到工作樹狀態＝無法證明乾淨，不冒充 HEAD
  }
}

const nextConfig: NextConfig = {
  env: {
    GIT_SHA: gitSha(),
    BUILD_AT: new Date().toISOString(),
  },
};

export default nextConfig;
