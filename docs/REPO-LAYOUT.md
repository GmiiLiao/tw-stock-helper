# 版本控管歸屬 — 哪一份才是「這個專案」

> 建立於 2026-07-31。任何在 `tw-stock-app/` 底下工作的人（含 AI 代理）**動手前先讀這頁**。

## 一句話

**`/Users/gmii/Documents/股票助手app/tw-stock-app/.git` 才是本專案的版控。**
往上那層 `/Users/gmii/.git` 是個人家目錄的大 repo，裡面混著別的專案，**不要往那邊提交本專案的東西**。

---

## 為什麼會有兩個 repo

| | 路徑 | 內容 | 建立時間 |
|---|---|---|---|
| **A. 家目錄 repo** | `/Users/gmii/.git` | 家目錄底下所有東西，包含 `Documents/Claude/Projects/訂閱制-線上學習網站/`、`kittenbotTW_web/`…以及**過去的 tw-stock-app 全部歷史** | 很早以前 |
| **B. 專案 repo（現行）** | `.../tw-stock-app/.git` | 只有 tw-stock-app | 2026-07-31 `git init` |

歷史經過：

1. tw-stock-app 一直沒有自己的 `.git`，所有提交其實都落在 **A**（家目錄 repo）。
   在 `tw-stock-app/` 底下跑 `git log` 看得到紀錄，是因為 git 會往上找 repo 根。
2. 2026-07-30 Cowork 進行效能最佳化時，在 `tw-stock-app/` 底下找不到 `.git`，
   於是在 `OPTIMIZATION-2026-07-30.md` 寫下「**專案沒有 git**」，
   並改用 `.backup_before_opt/` 作為唯一還原點。**這個判斷在當下是合理的**（工具沒往上找）。
3. 2026-07-31 在 `tw-stock-app/` 執行 `git init`，建立 **B**，提交了 2 個 commit：
   - `b51ff25` perf: 輪詢時段化、API 快取層、前端 code splitting
   - `f6d1561` chore: 排除最佳化作業的暫存與備份目錄

## 舊歷史沒有遺失

**A** 仍完整保留 tw-stock-app 的全部歷史，例如：

```
1b450a7 fix: 波段起漲從未出榜——歸檔空洞卡死 loadLuArchive，並補訊號擁擠揭露
76bf07a fix: 每日新聞改為當日最新——3小時滾動刷新+36h鮮度過濾+心跳看門狗
8d7d980 fix: 日K線缺最新一根——Yahoo逐檔漏日K(漲停股尤甚)
ab0cd1e feat: 隔日沖SOP三新變數檢定
a21524f feat: 波段起漲技能上線
```

查詢方式（**唯讀，不要在那裡提交本專案的變更**）：

```bash
git -C /Users/gmii log --oneline -- Documents/股票助手app/tw-stock-app
```

**B** 是新的起點，`b51ff25` 之前沒有歷史。這是刻意的取捨：把家目錄那份混雜的歷史搬進來，
會一併帶進別的專案的檔案，代價比失去 changelog 更高。需要考古時查 **A** 即可。

---

## 規則

1. **提交本專案的變更 → 一律用 B**（在 `tw-stock-app/` 底下直接 `git add` / `git commit`）。
2. **絕不** 在 A 提交 tw-stock-app 的東西 —— 會和 B 分岔，之後沒人分得清哪份是真的。
3. **絕不** 在 A 提交 `Documents/Claude/Projects/訂閱制-線上學習網站/`（另一個專案）的變更，
   即使 `git status` 顯示它們是 modified。
4. 需要查 2026-07-31 之前的歷史 → 用上面那條 `git -C /Users/gmii log` 唯讀查詢。
5. `.backup_before_opt/` 是 Cowork 最佳化前的原始檔快照，**在確認新版穩定前不要刪**。
   已列入 `.gitignore`，不進版控。`_to_delete/` 同理（1.8MB 舊壓縮檔，可自行清理）。

## 給 Cowork / 其他 AI 代理的交接說明

- 這個專案**現在有 git 了**。請不要再建立第三個 repo，也不要依賴 `.backup_before_opt/` 當還原點 ——
  用 `git stash` / `git revert` / 開分支即可。
- 進場先跑 `git -C . rev-parse --show-toplevel` 確認自己在 **B**：
  正確輸出是 `/Users/gmii/Documents/股票助手app/tw-stock-app`。
  若輸出是 `/Users/gmii`，代表 `.git` 不見了，**先停下來問人**，不要 `git init`。
- 提交訊息沿用 conventional commits（`feat:` `fix:` `perf:` `chore:` `docs:`），正體中文說明。

## 相關文件

| 檔案 | 內容 |
|---|---|
| [`CLAUDE.md`](../CLAUDE.md) | 架構、不變式、寫程式的規矩 —— **改任何東西前必讀** |
| [`OPTIMIZATION-2026-07-30.md`](../OPTIMIZATION-2026-07-30.md) | Cowork 第 1–7 步最佳化的完整紀錄 |
| [`docs/OPTIMIZATION-TODO.md`](./OPTIMIZATION-TODO.md) | 剩餘最佳化工作與順序 |
| [`docs/SECURITY-2026-07-31.md`](./SECURITY-2026-07-31.md) | 第二輪安全稽核與修補 |
