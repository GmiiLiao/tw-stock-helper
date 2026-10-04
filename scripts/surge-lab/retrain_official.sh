#!/bin/bash
# 起漲模型官方化重訓（2026-10-04）：A 官方漲停價 9995 佔位＝無漲跌幅／高價股照官方價、B 季財報分業法定期限、
# C 官方月營收（MOPS 本國＋-KY，2022-06 起）＋月營收嚴格 PIT（次月 10 日期限遇休市順延後的下一交易日）。
#
# 在「主 checkout」的 scripts/surge-lab 執行：bash retrain_official.sh
#   · 只用隔離快取 .surge-cache-L（研究 APFS 複本）；影子共用的 .surge-cache 與 dataset_t1／t2／lu1.npz 一律不碰。
#   · 帶官方化環境變數的 build 一律加 SURGE_DATASET_SUFFIX=L（→ dataset_{t1L,t2L,lu1L}.npz）；不加後綴的 build 在本腳本內不存在。
#   · 修正前的輸出已封存在 out/pre_fix_20261004/（本腳本不動它；缺了就拒跑）。
#   · 不連網：月營收只讀本機鏡像 second-brain/official 與 .surge-cache-L/revenue_supplement 的官方 CSV（含 provenance＋sha256）。
# 耗時（2026-10-04 量測）：build_v2 ≈ 35 秒、build_lu1 ≈ 30 秒、official_features ≈ 數分鐘、cv_official --quick 三任務平行 ≈ 30 分（lu1L 最久）。
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
PY=${PYTHON:-/Library/Frameworks/Python.framework/Versions/3.14/bin/python3}
unset SURGE_DATASET_SUFFIX SURGE_OFFICIAL_LIMIT SURGE_REVENUE SURGE_PIT_STRICT
export SURGE_CACHE=$HERE/.surge-cache-L
TASKS=(t1L t2L lu1L)

[ -d "$SURGE_CACHE" ] || { echo "❌ 缺研究快取 $SURGE_CACHE（先 cp -cR .surge-cache .surge-cache-L）"; exit 1; }
[ -f out/pre_fix_20261004/official_cv_t1L.json ] || { echo "❌ 修正前輸出封存 out/pre_fix_20261004/ 不在——先封存再重訓"; exit 1; }
"$PY" -c 'import numpy, pandas' || { echo "❌ $PY 沒有 numpy／pandas"; exit 1; }
echo "== $(date '+%T') 快取 $SURGE_CACHE；python $PY"

echo "== $(date '+%T') 官方月營收 → revenue_official.json"
"$PY" revenue_official.py

export SURGE_OFFICIAL_LIMIT=$SURGE_CACHE/official_limits.npz SURGE_REVENUE=revenue_official.json SURGE_PIT_STRICT=1
echo "== $(date '+%T') 官方標籤資料集 T1L／T2L"
SURGE_DATASET_SUFFIX=L "$PY" build_v2.py
echo "== $(date '+%T') 官方標籤資料集 LU1L"
SURGE_DATASET_SUFFIX=L "$PY" build_lu1.py
echo "== $(date '+%T') 官方特徵（*_off）"
"$PY" official_features.py --only t1L,t2L,lu1L
echo "   漲停判定對照（應只剩表頭）：$(wc -l < out/official_limit_disagree.csv | tr -d ' ') 行 out/official_limit_disagree.csv"

echo "== $(date '+%T') 三目標平行重訓（--quick：base＋official 各 3 種子）"
pids=()
for t in "${TASKS[@]}"; do
  "$PY" cv_official.py "$t" --quick > "out/cv_$t.log" 2>&1 &
  pids+=($!)
done
fail=0
for i in "${!TASKS[@]}"; do
  wait "${pids[$i]}" || { echo "❌ cv_official ${TASKS[$i]} 失敗（out/cv_${TASKS[$i]}.log）"; fail=1; }
done
[ $fail -eq 0 ] || exit 1

echo "== $(date '+%T') 穩健度（分半年／可買進／報酬）"
"$PY" cv_official_robust.py "${TASKS[@]}" > out/cv_robust.log 2>&1 || { tail -20 out/cv_robust.log; exit 1; }

echo "== $(date '+%T') 完成；摘要（新 vs 修正前 out/pre_fix_20261004/；報酬未扣成本；非投資建議）"
"$PY" - "${TASKS[@]}" <<'EOF'
import json, sys
rob = json.load(open('out/official_cv_robust.json'))
for t in sys.argv[1:]:
    new = json.load(open(f'out/official_cv_{t}.json')); old = json.load(open(f'out/pre_fix_20261004/official_cv_{t}.json'))
    m = new['_meta']
    print(f'[{t}] 測試列 {m["test_rows"]:,}、正例 {m["positives"]:,}、{m["days"]} 天、基準率 {m["base_rate"] * 100:.3f}%')
    for k in ('base', 'official'):
        a, b = new[k], old.get(k, {})
        ci = a.get('vs_base', {}).get('dprec')
        print(f'   {k:<9} AUC {a["auc"]:.4f}（前 {b.get("auc", float("nan")):.4f}）  前10精確度 {a["prec"] * 100:5.2f}%（前 {b.get("prec", float("nan")) * 100:5.2f}%）'
              f'  lift {a["lift"]:.2f}' + (f'  official−base 95% 區間 [{ci[0] * 100:+.2f}, {ci[1] * 100:+.2f}] 百分點' if ci else ''))
    r = rob.get(t, {})
    print(f'   分半年 official−base 區間：' + '；'.join(f'{h} {v["base"]}→{v["official"]} {v["diff_ci"]}' for h, v in r.get('by_half', {}).items()))
EOF
echo "   逐件命中／漏網：out/official_cv_{t1L,t2L,lu1L}_{base,official}_{hits,misses}.csv（T1L／T2L 另有 _outside.csv）"
echo "   逐列分數：$SURGE_CACHE/official_cv_scores_{t1L,t2L,lu1L}.npz；穩健度：out/official_cv_robust.json"
ls -1 "$SURGE_CACHE"/ranks_*L_off_*.npy 2>/dev/null | sed 's/^/   ranks 快取（列數不符者為孤兒檔，可手動刪）：/' || true
