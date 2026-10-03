"""特徵分組（供消融與報告用）。"""
GROUPS = {
 '波動/活躍度': ['atr14','vol10','vol60','vol_ratio_10_60','day_range','range20','range60','bbw','bbw_rank120','bb_pctb'],
 '當沖比': ['dt_ratio','dt_ratio20'],
 '漲停史': ['n_lu_20','n_lu_60','n_lu_250','days_since_lu'],
 '中長期趨勢/均線': ['r20','r60','r120','c_ma5','c_ma10','c_ma20','c_ma60','c_ma120','ma20_slope5','ma60_slope10','ma5_ma20','ma20_ma60','ma60_ma120','ma_tight','ma_tight4','n_above_ma','bull_align','pos20','pos60','pos120','dist_hi20','dist_hi60','dist_hi120','dist_hi240','brk20','brk60','rs20','rk_r20','rk_r60'],
 '短線動能/K線': ['r1','r3','r5','r10','rk_r5','up_days5','up_streak','body','gap','close_pos','upper_shadow','lower_shadow'],
 '量能': ['vr5','vr20','v5_20','v_dryup5','v_rank120','log_tv20','rk_vr20','rk_log_tv20','obv_slope20','updown_vol20','pv_up_surge'],
 '技術指標(MACD/KD/RSI)': ['macd_dif','macd_hist','macd_hist_d1','macd_hist_d3','macd_dif_pos','macd_hist_pos','macd_gold3','macd_gold10','kd_k','kd_d','kd_kd','kd_gold3','rsi5','rsi10','rsi14'],
 '法人籌碼': ['fgn_1','fgn_5','fgn_20','trust_1','trust_5','trust_20','trust_streak','fgn_streak','inst_pct_v1'],
 '融資券/借券': ['ml_chg5','ml_chg20','ml_to_v','ms_chg5','ms_to_ml','ms_to_v','lend_to_v','lend_chg5','lend_chg20'],
 '月營收': ['rev_yoy','rev_mom','rev_yoy_acc'],
 '產業共振': ['ind_lu_cnt','ind_lu_share','ind_lu_cnt5','ind_r5','ind_r5_rel'],
 '大盤環境': ['mkt_r1','mkt_r5','mkt_r20','mkt_breadth_ma20','mkt_lu_cnt','mkt_lu_cnt5','mkt_vol_ratio','mkt_near_hi'],
}
