"""經典技術條件 → 隔日起漲的機率倍數（同日調整 lift）。
lift_MH（欄名沿用）＝ 條件內正例數 ÷ Σ_日 (條件內列數 × 當日整體基準率)：間接標準化的 O/E（非嚴格 Mantel-Haenszel），控制「哪一天」的效應（大盤事件日不會灌水）。
CI ＝ 依日期重抽 400 次。同時列四個年度的 lift 看穩定度。"""
import numpy as np, pandas as pd, warnings
import evallib as E
warnings.filterwarnings('ignore')
pd.set_option('display.width', 240); pd.set_option('display.max_rows', 200)
D = E.load(primary_only=True); names = D['names']; X = D['X']; s, y = D['s'], D['y'].astype(np.int64)
f = lambda n: X[:, names.index(n)].astype(np.float64)
dates = np.array(D['dates']); yr = np.array([dates[i][:4] for i in s])
nday = np.bincount(s); pday = np.bincount(s, weights=y); rate_d = np.where(nday > 0, pday / np.maximum(nday, 1), 0)
rate_row = rate_d[s]
C = {}
def add(group, label, mask): C[(group, label)] = np.asarray(mask, dtype=bool) & True
# MACD
add('MACD', '近3日 MACD 黃金交叉', f('macd_gold3') == 1)
add('MACD', '近10日 MACD 黃金交叉', f('macd_gold10') == 1)
add('MACD', 'DIF>0（零軸上）', f('macd_dif_pos') == 1)
add('MACD', 'DIF>0 且 柱狀體>0 且 柱狀體放大', (f('macd_dif_pos') == 1) & (f('macd_hist') > 0) & (f('macd_hist_d1') > 0))
add('MACD', '柱狀體<0 且 轉強(連1日)', (f('macd_hist') < 0) & (f('macd_hist_d1') > 0))
add('MACD', 'DIF<0（零軸下）', f('macd_dif_pos') == 0)
# 均線
add('均線', '收盤>MA20', f('c_ma20') > 0); add('均線', '收盤>MA60', f('c_ma60') > 0); add('均線', '收盤>MA120', f('c_ma120') > 0)
add('均線', '多頭排列 MA5>10>20>60', f('bull_align') == 1)
add('均線', '站上 5 條均線', f('n_above_ma') == 5); add('均線', '站上 ≤1 條均線', f('n_above_ma') <= 1)
add('均線', 'MA20 上彎(5日>+1%)', f('ma20_slope5') > 0.01)
add('均線', 'MA5/10/20 糾結（價差<3%）', f('ma_tight') < 0.03)
add('均線', 'MA5/10/20/60 糾結（價差<5%）', f('ma_tight4') < 0.05)
add('均線', 'MA5/10/20 發散（價差≥8%）', f('ma_tight') >= 0.08)
add('均線', '收盤高於 MA60 ≥15%', f('c_ma60') >= 0.15)
add('均線', '收盤高於 MA120 ≥30%', f('c_ma120') >= 0.30)
# 價量
add('價量', '量比(vs前5日)≥2', f('vr5') >= 2); add('價量', '量比(vs前20日)≥2', f('vr20') >= 2); add('價量', '量比(vs前20日)≥3', f('vr20') >= 3)
add('價量', '量縮(近5日最低量<均量50%)', f('v_dryup5') < 0.5)
add('價量', '量為近120日前10%', f('v_rank120') >= 0.9)
add('價量', '當日量增價漲(量比≥1.5且收紅)', f('pv_up_surge') == 1)
add('價量', '5日均量<20日均量80%（量縮整理）', f('v5_20') < 0.8)
add('價量', '5日均量>20日均量120%（量能放大）', f('v5_20') > 1.2)
add('價量', '近20日上漲量/下跌量>1.5', f('updown_vol20') > 1.5)
# 突破／位置
add('位置', '收盤創20日新高', f('brk20') == 1); add('位置', '收盤創60日新高', f('brk60') == 1)
add('位置', '距20日高<3%', f('dist_hi20') > -0.03); add('位置', '距60日高<5%', f('dist_hi60') > -0.05); add('位置', '距240日高<10%', f('dist_hi240') > -0.10)
add('位置', '60日區間位置≥0.8', f('pos60') >= 0.8); add('位置', '20日區間位置≤0.2', f('pos20') <= 0.2)
# 動能
add('動能', '近5日漲≥10%', f('r5') >= 0.10); add('動能', '近20日漲≥20%', f('r20') >= 0.20); add('動能', '近20日跌≥10%', f('r20') <= -0.10)
add('動能', '近60日漲≥50%', f('r60') >= 0.50); add('動能', '近120日漲≥100%', f('r120') >= 1.0)
add('動能', '當日跌≥3%', f('r1') <= -0.03); add('動能', '當日漲≥3%', f('r1') >= 0.03); add('動能', '連漲≥3日', f('up_streak') >= 3)
add('動能', '當日收在區間下 30%', f('close_pos') <= 0.3); add('動能', '當日長上影(≥2%)', f('upper_shadow') >= 0.02)
# KD / RSI / 布林
add('KD/RSI/布林', '近3日 KD 黃金交叉', f('kd_gold3') == 1); add('KD/RSI/布林', 'K<20（超賣）', f('kd_k') < 20); add('KD/RSI/布林', 'K>80', f('kd_k') > 80)
add('KD/RSI/布林', 'RSI14>70', f('rsi14') > 70); add('KD/RSI/布林', 'RSI14<30', f('rsi14') < 30); add('KD/RSI/布林', 'RSI5<20', f('rsi5') < 20)
add('KD/RSI/布林', '布林帶寬歷史後20%（收斂）', f('bbw_rank120') <= 0.2); add('KD/RSI/布林', '布林帶寬歷史前20%（擴張）', f('bbw_rank120') >= 0.8)
# 股性（波動／當沖／漲停史）
add('股性', 'ATR14≥5%', f('atr14') >= 0.05); add('股性', 'ATR14≥7%', f('atr14') >= 0.07); add('股性', 'ATR14<3%', f('atr14') < 0.03)
add('股性', '當沖比(20日)≥40%', f('dt_ratio20') >= 0.40); add('股性', '當沖比(20日)<20%', f('dt_ratio20') < 0.20)
add('股性', '近60日有漲停≥1次', f('n_lu_60') >= 1); add('股性', '近60日漲停≥3次', f('n_lu_60') >= 3); add('股性', '近250日漲停≥5次', f('n_lu_250') >= 5); add('股性', '近250日從未漲停', f('n_lu_250') == 0)
add('股性', '距上次漲停≤10日', f('days_since_lu') <= 10)
add('股性', '近20日振幅(高低)≥40%', f('range20') >= 0.40)
# 籌碼
add('籌碼', '外資5日買超>均量10%', f('fgn_5') > 0.10); add('籌碼', '投信5日買超>均量3%', f('trust_5') > 0.03); add('籌碼', '投信連買≥3日', f('trust_streak') >= 3)
add('籌碼', '外資20日買超>均量50%', f('fgn_20') > 0.5); add('籌碼', '外資5日賣超>均量10%', f('fgn_5') < -0.10)
add('籌碼', '融資20日增≥10%', f('ml_chg20') >= 0.10); add('籌碼', '融資20日減≥10%', f('ml_chg20') <= -0.10)
add('籌碼', '融券/融資(券資比)≥3%', f('ms_to_ml') >= 0.03)
add('籌碼', '借券餘額/均量<0.5倍（少）', f('lend_to_v') < 0.5); add('籌碼', '借券餘額/均量>3倍（多）', f('lend_to_v') > 3)
add('籌碼', '借券餘額20日增>均量50%', f('lend_chg20') > 0.5)
# 營收／產業
add('營收/產業', '月營收年增≥20%', f('rev_yoy') >= 20); add('營收/產業', '月營收年增<0%', f('rev_yoy') < 0); add('營收/產業', '月營收年增加速(+10pp)', f('rev_yoy_acc') >= 10)
add('營收/產業', '同產業近5日漲停≥3檔', f('ind_lu_cnt5') >= 3); add('營收/產業', '同產業近5日無漲停', f('ind_lu_cnt5') == 0)
# 組合
add('組合', '股性: ATR≥5% 且 近250日漲停≥3', (f('atr14') >= 0.05) & (f('n_lu_250') >= 3))
add('組合', '股性+趨勢: 上列 且 站上MA60', (f('atr14') >= 0.05) & (f('n_lu_250') >= 3) & (f('c_ma60') > 0))
add('組合', '股性+趨勢+借券少', (f('atr14') >= 0.05) & (f('n_lu_250') >= 3) & (f('c_ma60') > 0) & (f('lend_to_v') < 1))
add('組合', '股性+趨勢+同產業近5日漲停≥3', (f('atr14') >= 0.05) & (f('n_lu_250') >= 3) & (f('c_ma60') > 0) & (f('ind_lu_cnt5') >= 3))

rng = np.random.default_rng(3)
nd = len(nday)
rows = []
for (g, lab), m in C.items():
    cnt = m.sum()
    if cnt < 2000: continue
    obs_d = np.bincount(s, weights=(y * m), minlength=nd); exp_d = np.bincount(s, weights=(m * rate_row), minlength=nd)
    pos = obs_d.sum()
    lift = pos / exp_d.sum()
    days = np.nonzero(nday > 0)[0]
    bs = []
    for _ in range(300):
        idx = rng.choice(days, len(days)); bs.append(obs_d[idx].sum() / max(exp_d[idx].sum(), 1e-9))
    lo, hi = np.percentile(bs, [2.5, 97.5])
    # 區塊 bootstrap（事件在時間上成群、相鄰日不獨立 → 逐日 CI 偏窄）：循環區塊，每塊 20 個連續交易日
    L = 20; nb = int(np.ceil(nd / L)); bb = []
    for _ in range(300):
        st = rng.integers(0, nd, nb); idx = ((st[:, None] + np.arange(L)[None, :]).ravel()[:nd]) % nd
        bb.append(obs_d[idx].sum() / max(exp_d[idx].sum(), 1e-9))
    blo, bhi = np.percentile(bb, [2.5, 97.5])
    r = dict(group=g, cond=lab, n=int(cnt), share=cnt / len(s) * 100, events=int(pos), rate=pos / cnt * 100, lift_MH=lift, lo=lo, hi=hi, blo=blo, bhi=bhi)
    for Y in ('2023', '2024', '2025', '2026'):
        mm = (yr == Y)
        o = np.bincount(s[mm], weights=(y * m)[mm], minlength=nd).sum(); e = np.bincount(s[mm], weights=(m * rate_row)[mm], minlength=nd).sum()
        r[Y] = o / e if e > 0 else np.nan
    rows.append(r)
R = pd.DataFrame(rows)
R['sig'] = np.where((R.blo > 1) | (R.bhi < 1), '*', '')   # 以區塊 CI 判定
R.to_csv(f'{E.B.SP}/conditions{E.TAG}.csv', index=False)
print(f'母體基準率 {y.mean() * 100:.3f}%')
for g in ['MACD', '均線', '價量', '位置', '動能', 'KD/RSI/布林', '股性', '籌碼', '營收/產業', '組合']:
    print(f'\n── {g} ──')
    print(R[R.group == g].drop(columns='group').round(2).to_string(index=False))
