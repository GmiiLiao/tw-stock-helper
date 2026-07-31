import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

// eslint-config-next ships the legacy (eslintrc) format, so it must be bridged
// into flat config via FlatCompat rather than spread directly.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // These rules surfaced ~60 pre-existing violations the moment the (previously
    // broken) ESLint config started running. They are downgraded to warnings so
    // they stay visible without blocking `next build`; tighten incrementally.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "prefer-const": "warn",
    },
  },
  {
    // .firebase 是 deploy 產物（內含打包過的 app + node_modules 副本），
    // 不加進來的話 `npm run lint` 會噴 2000+ 個與原始碼無關的 error，
    // 使得這個指令完全失去訊號價值。
    ignores: [
      ".next/**", "out/**", "build/**", "next-env.d.ts",
      ".firebase/**", "second-brain/**",
      "_to_delete/**", ".backup_before_opt/**",
    ],
  },
];

export default eslintConfig;
