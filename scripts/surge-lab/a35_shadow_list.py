"""a35_shadow_list.py — 凍結影子預測產生器（研究型 GBDT「隔日漲停」排名 → 站上預測的影子對照）。

用法
  python3 a35_shadow_list.py                       # 打分日＝面板最後一個交易日；寫 out/shadow_{日}.json
  python3 a35_shadow_list.py --day 2026-10-02      # 指定打分日
  python3 a35_shadow_list.py --day 2026-10-02 --target-day 2026-10-05 --workers 3
  python3 a35_shadow_list.py --day 2026-10-02 --out /tmp/x.json --no-firestore --no-reuse   # 重現性檢查（不用快取模型）
輸出 out/shadow_{日}.json：產生時間（Asia/Taipei）、訓練截止日、模型雜湊、分市場／整體前 30（含分數與已漲停／一字鎖旗標）、
      站上同日已發佈 pred 前 30、當日兩市漲跌停／成交值上下文、整份 canonical JSON 的 sha256。
協定細節見 a35_shadow_lib.py 檔頭與 a35_shadow_RUNBOOK.md。⚠ 影子模式：不改站上預測、不寫 Firestore。
輸出檔已存在時拒絕覆蓋（凍結檔只寫一次），除非 --force 或 --out 另指新路徑。
"""
import os
import sys
import argparse
import warnings
import numpy as np
import a35_shadow_lib as L

warnings.filterwarnings('ignore')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--day', help='打分日 YYYY-MM-DD（預設＝面板最後一個交易日）')
    ap.add_argument('--target-day', help='預期的下一交易日（預設＝下一個週一～五；掃描時以面板實際下一交易日為準）')
    ap.add_argument('--out', help='輸出路徑（預設 out/shadow_{日}.json）')
    ap.add_argument('--workers', type=int, default=3, help='同時訓練的 seed 數（預設 3）')
    ap.add_argument('--no-firestore', action='store_true', help='不讀 Firestore，站上 pred 改取 lu_scoreboard.json 快照')
    ap.add_argument('--no-reuse', action='store_true', help='不使用 .surge-cache/a35_models 的快取模型（強制重訓）')
    ap.add_argument('--force', action='store_true', help='覆蓋已存在的輸出檔（凍結檔不建議）')
    a = ap.parse_args()

    L.log('載入面板與特徵…')
    x = L.build_ctx()
    day = a.day or x.dates[-1]
    if day not in x.dates: sys.exit(f'面板沒有 {day}（面板 {x.dates[0]}～{x.dates[-1]}）')
    t = x.dates.index(day)
    out = a.out or os.path.join(L.OUT, f'shadow_{day}.json')
    if os.path.exists(out) and not a.force: sys.exit(f'{out} 已存在（凍結檔不覆蓋；要重產請 --force 或改 --out）')
    fin = np.isfinite(x.P['C'][t])
    n_tpex, n_tse = int(((x.mk == 'otc') & fin).sum()), int(((x.mk == 'tse') & fin).sum())
    L.log(f'打分日 {day}（t={t}/{x.T - 1}）；當日收盤檔數 上市 {n_tse}、上櫃 {n_tpex}')
    if n_tpex < 500: sys.exit(f'上櫃收盤只有 {n_tpex} 檔（< 500），疑似上櫃資料尚未到齊，拒絕凍結（見 TPEx 延遲問題）')

    store = L.Store()
    L.check_alignment(store, x)
    ens = L.train_ensemble(L.cutoff_index(x.dates, t), workers=a.workers, reuse=not a.no_reuse, store=store)
    fs = {} if a.no_firestore else L.site_from_firestore([day])
    if not a.no_firestore: L.log(f'Firestore 站上 pred-{day}：' + ('讀到' if fs.get(day) else '讀不到→退回 lu_scoreboard.json 快照'))
    cmd = 'python3 ' + ' '.join(['a35_shadow_list.py'] + sys.argv[1:])
    obj = L.build_frozen(x, t, ens, store.names, kind='frozen-forward' if t == x.T - 1 else 'frozen-backfill', fs=fs, target_day=a.target_day, command=cmd)
    L.write_json(out, obj)
    L.log(f'寫入 {out}  sha256={obj["sha256"]}  modelHash={obj["modelHash"][:16]}  訓練截止 {obj["training"]["cutoffDate"]}')
    for name in ('overallTop30', 'twseTop30', 'tpexTop30'):
        top = obj['lists'][name][:10]
        print(f'  {name}: ' + ' '.join(f'{e["code"]}{"*" if e["limitUpAtS"] else ""}({e["score"]:.2f})' for e in top))
    print(f'  站上 pred-{day} 前 10：' + ' '.join((obj['site'].get('codes') or [])[:10]) + f'；與影子整體前 30 重疊 {obj["site"]["overlapWithOverallTop30"]} 檔')
    return 0


if __name__ == '__main__':
    sys.exit(main())
