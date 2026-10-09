import { execSync } from "node:child_process";
import { PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

// 會進 build 產物的路徑：這些地方有未提交（含未追蹤）的修改時，部署身分加 -dirty（2026-10-04·WM-SCAN G4-05）——
// 否則從髒樹 build 的線上 sha 仍等於 HEAD，「sha＝HEAD 才可宣稱已部署」會假陽性。
const BUILD_PATHS = ["src", "public", "package.json", "package-lock.json", "next.config.mjs", "tsconfig.json"];

// build 時注入部署身分，供 /api/system/version 回報（沒有 git 時回 null，不捏造）
function gitSha() {
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

// 2026-10-09：由 next.config.ts 改為 .mjs——next 15.5.27 在 SSR 函式執行時會重新載入設定，.ts 需要 typescript，
//   而 Cloud Functions 只裝正式依賴 ⇒ 全站 API 500（「Cannot find module 'typescript'」）。
// 2026-10-09（全站掃描第 5 項）：改為 (phase) => config——只在 build／dev 階段跑 git 算部署身分。
//   執行時（phase-production-server，雲端沒有 git）重新載入設定不再呼叫 execSync('git')（舊版每次都被 catch 吃掉）；
//   GIT_SHA／BUILD_AT 已在 build 時內嵌進產物，執行時的 env 值不影響 /api/system/version。
const BUILD_PHASES = new Set([PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER]);

/** @param {string} phase @returns {import('next').NextConfig} */
export default function nextConfig(phase) {
  const isBuild = BUILD_PHASES.has(phase);
  return {
    env: {
      GIT_SHA: isBuild ? gitSha() : (process.env.GIT_SHA || ""),
      BUILD_AT: isBuild ? new Date().toISOString() : (process.env.BUILD_AT || ""),
    },
  };
}
