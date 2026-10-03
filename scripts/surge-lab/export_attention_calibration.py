"""把研究端結果輸出成正式程式讀取的 scripts/data/attention-calibration.json（只含查表需要的數字＋出處）。
來源：a27_calibration.py（S5 細分段）、s5_3bucket.json（S5 三段，與經驗庫 CUTS.sum5 切點一致）、a29_pit_escalation.py（前視安全的升級分級）。
⚠ a27 的 escalation10（依公告列「累計次數」）已作廢，不輸出。"""
import json, os, sys, datetime
SP = os.environ.get('SURGE_CACHE', os.path.join(os.path.dirname(os.path.abspath(__file__)), '.surge-cache'))
src = json.load(open(f'{SP}/attention_calibration.json'))
s5_3 = json.load(open(f'{SP}/s5_3bucket.json'))
esc = json.load(open(f'{SP}/escalation_pit.json'))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'attention-calibration.json')
doc = {
    '_doc': '注意股校準表（2026-10-03 起漲特徵實驗產出；docs/SURGE-ATTENTION-2026-10-03.md §5、§9.2）。歷史統計、非保證、非投資建議。'
            's5：前 5 個交易日（含當日）單日收盤報酬率的算術加總 → 隔日出現漲幅型注意公告的機率（流動股＝收盤≥10、20 日均量≥300 張；'
            'fresh＝近 10 日無任何注意公告、inAttention＝近 10 日已有、all＝不分）。'
            'escalation10：D 日狀態 → 10 個交易日內出現處置公告的機率（流動股、非處置中；以官方處置規則模擬、2026-10-02 官方名單 9/9 吻合）。',
    'generatedAt': sys.argv[1] if len(sys.argv) > 1 else datetime.date.today().isoformat(),
    'source': 'scripts/surge-lab/a27_calibration.py、a29_pit_escalation.py；官方 TWSE announcement/notice、notetrans、punish，TPEx bulletin/attention、warning、disposal；chipArchive 收盤',
    'window': src['window'],
    's5': {'edges': src['edges'], 'labels': src['buckets'],
           'nextDay': {'fresh': src['nextDay']['未在注意中|all'], 'inAttention': src['nextDay']['近10日已有注意|all']},
           'n': {'fresh': src['n']['未在注意中|all'], 'inAttention': src['n']['近10日已有注意|all']}},
    's5Tiers': {'edges': [0.15, 0.24], 'labels': ['<15%', '15~24%', '≥24%'],
                'nextDay': {g: [b['p'] for b in s5_3[g]] for g in ('fresh', 'inAttention', 'all')},
                'n': {g: [b['n'] for b in s5_3[g]] for g in ('fresh', 'inAttention', 'all')}},
    'escalation10': {
        'definition': {
            'high': '官方「可能達處置」名單（TWSE notetrans／TPEx 處置預告）',
            'mid': '當日注意且含計入處置的條款（上市第 1～5、7、8 款；上櫃第 1～8 款），未在可能達處置名單',
            'low': '當日注意但只因不計入處置的條款（上市第 6、9～13 款；上櫃第 9～13 款）',
            'none': '當日無注意',
        },
        'countingClauses': {'tse': [1, 2, 3, 4, 5, 7, 8], 'otc': [1, 2, 3, 4, 5, 6, 7, 8]},
        'high': esc['near'], 'mid': esc['att18'], 'low': esc['heatOnly'], 'none': esc['none'],
    },
}
json.dump(doc, open(OUT, 'w'), ensure_ascii=False, indent=1)
print('→', os.path.normpath(OUT)); print(json.dumps(doc['escalation10'], ensure_ascii=False)); print(json.dumps(doc['s5Tiers'], ensure_ascii=False))
