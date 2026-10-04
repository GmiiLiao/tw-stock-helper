"""a35_shadow_history.py — 「若當時就用同一套程序」的歷史影子名單（would-have-been track）。

用法
  python3 a35_shadow_history.py                                   # 2026-07-16～2026-10-01，每週重訓一次，6 個程序
  python3 a35_shadow_history.py --from 2026-07-16 --to 2026-10-01 --workers 6 --retrain weekly
  python3 a35_shadow_history.py --retrain daily                   # 每個打分日各自訓練（精確協定；約為 weekly 的 4～5 倍時間）
  python3 a35_shadow_history.py --score                           # 產生後順手對答案（等同再跑 a35_shadow_score.py 'out/shadow_hist/shadow_*.json'）
重訓頻率（為了省時；與正式前向測試的「每日重訓」協定的唯一差別）：
  · weekly：以 ISO 週為一塊，該週第一個打分日 A 當錨點，訓練截止 s' ≤ A − 3 個交易日，整週共用同一組（3 seeds）模型。
    週內最晚的打分日（週四）其訓練資料比「每日重訓」舊 3 個交易日——不含任何較新的資料，只會偏保守（較舊），不會前視。
  · 每份檔記錄 training.anchorDay／cutoffDate／retrain，可逐日追溯。
輸出 out/shadow_hist/shadow_{日}.json（schema 同凍結檔，kind=historical-would-have-been）；已存在不覆蓋（--force 才重產）。
站上同日 pred 一次讀 Firestore（唯讀）；讀不到才退回 lu_scoreboard.json 快照。⚠ 影子模式：不寫 Firestore。
"""
import os
import sys
import argparse
import datetime
import subprocess
import warnings
import a35_shadow_lib as L

warnings.filterwarnings('ignore')


def blocks(days: list, mode: str) -> dict:
    """打分日 → 錨點日。"""
    if mode == 'daily': return {d: d for d in days}
    out, cur_key, anchor = {}, None, None
    for d in days:
        iso = datetime.date.fromisoformat(d).isocalendar()
        key = (iso[0], iso[1])
        if key != cur_key: cur_key, anchor = key, d
        out[d] = anchor
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--from', dest='frm', default='2026-07-16'); ap.add_argument('--to', default='2026-10-01')
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--retrain', choices=('weekly', 'daily'), default='weekly')
    ap.add_argument('--outdir', default=os.path.join(L.OUT, 'shadow_hist'))
    ap.add_argument('--no-firestore', action='store_true'); ap.add_argument('--no-reuse', action='store_true')
    ap.add_argument('--force', action='store_true'); ap.add_argument('--score', action='store_true')
    a = ap.parse_args()

    L.log('載入面板與特徵…')
    x = L.build_ctx()
    days = [d for d in x.dates if a.frm <= d <= a.to and x.dates.index(d) + 1 < x.T]      # 需有下一交易日才能事後對答案
    L.log(f'歷史打分日 {len(days)} 個：{days[0]}～{days[-1]}；重訓頻率 {a.retrain}')
    anchors = blocks(days, a.retrain)
    cut = {d: L.cutoff_index(x.dates, x.dates.index(anchors[d])) for d in days}
    store = L.Store()
    L.check_alignment(store, x)
    ens = L.train_ensembles(sorted(set(cut.values())), workers=a.workers, reuse=not a.no_reuse, store=store)
    fs = {} if a.no_firestore else L.site_from_firestore(days)
    if not a.no_firestore: L.log(f'Firestore 站上 pred 讀到 {len(fs)}/{len(days)} 日（讀不到者退回 lu_scoreboard.json 快照）')
    cmd = 'python3 ' + ' '.join(['a35_shadow_history.py'] + sys.argv[1:])
    n_new = 0
    for d in days:
        out = os.path.join(a.outdir, f'shadow_{d}.json')
        if os.path.exists(out) and not a.force: continue
        t = x.dates.index(d)
        obj = L.build_frozen(x, t, ens[cut[d]], store.names, kind='historical-would-have-been', fs=fs, target_day=x.dates[t + 1], anchor_day=anchors[d], command=cmd)
        L.write_json(out, obj); n_new += 1
        top = obj['lists']['overallTop30'][:5]
        L.log(f'{d} → {x.dates[t + 1]}  錨點 {anchors[d]} 截止 {obj["training"]["cutoffDate"]}  前 5：' + ' '.join(f'{e["code"]}{"*" if e["limitUpAtS"] else ""}' for e in top) + f'  站上重疊 {obj["site"]["overlapWithOverallTop30"]}')
    L.log(f'完成：新寫 {n_new} 份，目錄 {a.outdir}')
    if a.score:
        r = subprocess.run([sys.executable, os.path.join(L.HERE, 'a35_shadow_score.py'), os.path.join(a.outdir, 'shadow_*.json'), '--quiet-days', '--out', os.path.join(L.OUT, 'shadow_hist_score_pooled.json')])
        return r.returncode
    return 0


if __name__ == '__main__':
    sys.exit(main())
