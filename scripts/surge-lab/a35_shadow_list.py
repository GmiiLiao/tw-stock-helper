"""a35_shadow_list.py — 凍結影子預測產生器（研究型 GBDT「隔日漲停」排名 → 站上預測的影子對照）。

用法
  python3 a35_shadow_list.py                       # 打分日＝面板最後一個交易日；寫 out/shadow_{日}.json
  python3 a35_shadow_list.py --day 2026-10-02      # 指定打分日
  python3 a35_shadow_list.py --day 2026-10-02 --target-day 2026-10-05 --workers 3
  python3 a35_shadow_list.py --day 2026-10-02 --out /tmp/x.json --no-firestore --no-reuse   # 重現性檢查（不用快取模型）
輸出 out/shadow_{日}.json：產生時間（Asia/Taipei）、訓練截止日、模型雜湊、分市場／整體前 30（含分數與已漲停／一字鎖旗標）、
      站上同日已發佈 pred 前 30、當日兩市漲跌停／成交值上下文、整份 canonical JSON 的 sha256。
      另記資料依據（2026-10-04 每日自動化）：targetDayBasis（休市日曆來源）、dataBasis（打分日收盤歸檔的到齊狀態與是否含第三方補洞）、
      revenueSha256（上線特徵讀的 revenue.json）、exrightCoverage（除權息涵蓋）、featureData（訓練矩陣與營收是否同一版）。
目標日＝休市日曆（Firestore system/tradingCalendar，退回本機官方鏡像休市表）推得的下一交易日；--target-day 與日曆不符就拒絕。
時鐘閘：事前凍結（打分日＝面板最後一日）必須在目標日 09:00（台北）前寫成；來不及就寫 out/shadow_missed_{日}.json 並以結束碼 4 退出。
協定細節見 a35_shadow_lib.py 檔頭與 a35_shadow_RUNBOOK.md。⚠ 影子模式：不改站上預測、不寫 Firestore。
輸出檔已存在時拒絕覆蓋（凍結檔只寫一次），除非 --force 或 --out 另指新路徑。
結束碼：0 寫入；4 錯過凍結時限（missed）；5 打分日資料未到齊；6 訓練矩陣與營收版本不一致；7 休市日曆問題；1 其他拒絕。
"""
import os
import sys
import argparse
import datetime
import warnings
import numpy as np
import a35_shadow_lib as L

warnings.filterwarnings('ignore')


def refuse(code: int, msg: str) -> int:
    print(msg, file=sys.stderr, flush=True)
    return code


def record_missed(day: str, target: str, reason: str, cmd: str) -> str:
    """錯過事前凍結時限：不寫 frozen-forward，只留一份缺口紀錄（publish 的檔名規則不收它）。"""
    path = os.path.join(L.OUT, f'shadow_missed_{day}.json')
    L.write_json(path, dict(schema='a35.shadow.missed.v1', scoringDay=day, targetDay=target, deadline=L.freeze_deadline(target).isoformat(),
                            recordedAt=L.now_iso(), reason=reason, command=cmd))
    return path


def resolve_target(day: str, x: L.Ctx, t: int, explicit: str, use_firestore: bool) -> tuple:
    """回傳 (目標日, targetDayBasis)；不可判定時丟 CalendarError。"""
    cal = L.load_calendar(use_firestore=use_firestore)
    computed, err = None, None
    try: computed = L.next_trading_day(day, cal)
    except L.CalendarError as e: err = str(e)
    basis = dict(sources=(cal or {}).get('sources', []), computed=computed, error=err, explicit=explicit)
    if t + 1 < x.T:                                   # 面板已有下一日（補產／演練）：以面板實際下一交易日為準
        actual = x.dates[t + 1]
        if explicit and explicit != actual: raise L.CalendarError(f'--target-day {explicit} 與面板實際下一交易日 {actual} 不符')
        basis['panelNext'] = actual
        return actual, basis
    if explicit:
        if computed and explicit != computed: raise L.CalendarError(f'--target-day {explicit} 與休市日曆推得的下一交易日 {computed} 不符（來源 {basis["sources"]}）')
        if not computed: L.log(f'⚠ 休市日曆無法驗證 --target-day {explicit}：{err}')
        return explicit, basis
    if not computed: raise L.CalendarError(err or '休市日曆無法推得下一交易日')
    return computed, basis


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--day', help='打分日 YYYY-MM-DD（預設＝面板最後一個交易日）')
    ap.add_argument('--target-day', help='預期的下一交易日（預設＝休市日曆推得的下一交易日；給了就必須與日曆一致）')
    ap.add_argument('--out', help='輸出路徑（預設 out/shadow_{日}.json）')
    ap.add_argument('--workers', type=int, default=3, help='同時訓練的 seed 數（預設 3）')
    ap.add_argument('--no-firestore', action='store_true', help='不讀 Firestore：站上 pred 改取 lu_scoreboard.json 快照、休市日曆只用本機鏡像')
    ap.add_argument('--no-reuse', action='store_true', help='不使用 .surge-cache/a35_models 的快取模型（強制重訓）')
    ap.add_argument('--force', action='store_true', help='覆蓋已存在的輸出檔（凍結檔不建議）')
    ap.add_argument('--require-matrix-sidecar', action='store_true', help='訓練矩陣必須有對得上的建置側檔且營收版本相同（a35_shadow_daily.mjs 用）')
    a = ap.parse_args()
    cmd = 'python3 ' + ' '.join(['a35_shadow_list.py'] + sys.argv[1:])

    L.log('載入面板與特徵…')
    x = L.build_ctx()
    day = a.day or x.dates[-1]
    if day not in x.dates: return refuse(1, f'面板沒有 {day}（面板 {x.dates[0]}～{x.dates[-1]}）')
    t = x.dates.index(day)
    out = a.out or os.path.join(L.OUT, f'shadow_{day}.json')
    if os.path.exists(out) and not a.force: return refuse(1, f'{out} 已存在（凍結檔不覆蓋；要重產請 --force 或改 --out）')
    kind = 'frozen-forward' if t == x.T - 1 else 'frozen-backfill'
    try: target, target_basis = resolve_target(day, x, t, a.target_day, not a.no_firestore)
    except L.CalendarError as e: return refuse(L.EXIT_CALENDAR, f'目標日無法判定：{e}')
    deadline = L.freeze_deadline(target)
    L.log(f'打分日 {day}（{kind}）→ 目標日 {target}（{"、".join(target_basis["sources"]) or "無日曆"}）；事前凍結時限 {deadline.isoformat()}')
    if kind == 'frozen-forward' and datetime.datetime.now(L.TZ) >= deadline:
        p = record_missed(day, target, 'clock-gate-before-training', cmd)
        return refuse(L.EXIT_MISSED, f'已過目標日 {target} 09:00，不能再產生事前凍結名單——記為缺口 {p}')

    fin = np.isfinite(x.P['C'][t])
    n_tpex, n_tse = int(((x.mk == 'otc') & fin).sum()), int(((x.mk == 'tse') & fin).sum())
    L.log(f'當日收盤檔數 上市 {n_tse}、上櫃 {n_tpex}')
    if n_tpex < 500: return refuse(L.EXIT_NOT_READY, f'上櫃收盤只有 {n_tpex} 檔（< 500），疑似上櫃資料尚未到齊，拒絕凍結（見 TPEx 延遲問題）')
    basis = L.data_basis(day)
    L.log(f'資料依據（快取 chipArchive/{day}）：' + (basis.get('error') or f'ready={basis.get("ready")} {basis.get("basis")} 缺 {basis.get("missing")}'))
    if kind == 'frozen-forward' and not basis.get('ready'):
        return refuse(L.EXIT_NOT_READY, f'打分日 {day} 的收盤歸檔未到齊或無法判定（{basis.get("error") or basis.get("missing")}），拒絕凍結')

    store = L.Store()
    L.check_alignment(store, x)
    fd = L.feature_data()
    L.log(f'特徵資料：矩陣 {fd["matrixId"][:12]}、revenue.json {fd["revenueSha256"][:12]}、一致性 {fd["consistency"]}')
    if fd['consistency'] == 'revenue-changed':
        return refuse(L.EXIT_INCONSISTENT, f'訓練矩陣建置時的 revenue.json（{(fd["matrixRevenueSha256"] or "")[:12]}）與目前（{fd["revenueSha256"][:12]}）不同——'
                      '訓練與上線特徵會不一致，請先重建：python3 build_lu1.py && python3 a32_walkforward_prep.py')
    if a.require_matrix_sidecar and fd['consistency'] != 'ok':
        return refuse(L.EXIT_INCONSISTENT, f'訓練矩陣一致性 {fd["consistency"]}（--require-matrix-sidecar）：請先重建 build_lu1.py && a32_walkforward_prep.py')
    ens = L.train_ensemble(L.cutoff_index(x.dates, t), workers=a.workers, reuse=not a.no_reuse, store=store, data_sig=fd['sig'])
    fs = {} if a.no_firestore else L.site_from_firestore([day])
    if not a.no_firestore: L.log(f'Firestore 站上 pred-{day}：' + ('讀到' if fs.get(day) else '讀不到→退回 lu_scoreboard.json 快照'))
    extra = dict(targetDayBasis=target_basis, freezeDeadline=deadline.isoformat(), dataBasis=basis,
                 revenueSha256=fd['revenueSha256'], exrightCoverage=L.exright_coverage(x.dates, day),
                 featureData={k: fd[k] for k in ('sig', 'matrixId', 'revenueSha256', 'matrixRevenueSha256', 'matrixBuilt', 'consistency')})
    obj = L.build_frozen(x, t, ens, store.names, kind=kind, fs=fs, target_day=target, command=cmd, extra=extra)
    if kind == 'frozen-forward' and not L.frozen_before_open(obj['generatedAt'], target):
        p = record_missed(day, target, 'clock-gate-after-training', cmd)
        return refuse(L.EXIT_MISSED, f'訓練完成時已過目標日 {target} 09:00（{obj["generatedAt"]}）——不寫事前凍結名單，記為缺口 {p}')
    L.write_json(out, obj)
    L.log(f'寫入 {out}  sha256={obj["sha256"]}  modelHash={obj["modelHash"][:16]}  訓練截止 {obj["training"]["cutoffDate"]}')
    if not obj['exrightCoverage']['complete']: L.log(f'⚠ 除權息涵蓋不完整：{[d for d in obj["exrightCoverage"]["days"] if d["status"] != "fetched"]}')
    for name in ('overallTop30', 'twseTop30', 'tpexTop30'):
        top = obj['lists'][name][:10]
        print(f'  {name}: ' + ' '.join(f'{e["code"]}{"*" if e["limitUpAtS"] else ""}({e["score"]:.2f})' for e in top))
    print(f'  站上 pred-{day} 前 10：' + ' '.join((obj['site'].get('codes') or [])[:10]) + f'；與影子整體前 30 重疊 {obj["site"]["overlapWithOverallTop30"]} 檔')
    return 0


if __name__ == '__main__':
    sys.exit(main())
