"""官方月營收 → {SP}/revenue_official.json（2026-10-04；研究 L 管線以 SURGE_REVENUE=revenue_official.json 切換）。

為什麼：{SP}/revenue.json（Firestore revenueArchive 匯出）只抓了 MOPS t21sc03 的 _0 表（本國公司），
       120 檔外國發行人（-KY，在 _1 表）月營收全缺；且只從 2023-08 開始。

來源（全部官方、零網路）
  · 本機鏡像 second-brain/official/mopsov.twse.com.tw/mops_t21sc03（_0 本國）與 mops_t21sc03_ky（_1 外國／-KY），
    {YYYY-MM}.{sii|otc}.html.gz（原始 big5 位元組）。只收 manifest status=ok 且 final 不是 false 的頁；解壓後位元組的 sha256
    須等於 manifest 記錄的 sha256（不符＝鏡像檔壞或被換，中止）；頁面須回聲「{上市|上櫃}公司{民國年}年{月}月份」與「單位：千元」，否則中止。
    定版規則逐頁記錄在報告（finalRule）：finalBy='stable'＝內容穩定定版（revenue-ky 軌道 c6dba68 起的 t21sc03 規則：
    次月 11 日起相隔 ≥3 日兩次抓取內容相同）；final=true 而沒有 finalBy＝舊時鐘規則定版（clock）。
    --require-stable：只收 stable 定版頁（clock 頁當作未定版而略過 ⇒ 缺頁中止，除非 --allow-missing）——
    revenue-ky 合併且 stable 定版跑完後重建 revenue_official.json 要加這個旗標，「定版看資料不看時鐘」才完整。
    revenue-ky 的回補會把舊 clock 頁重抓一次：兩次觀測相隔 <3 日或內容有變的頁會寫成 final=false ⇒ 本程式缺頁中止（不靜默掉資料）。
  · 補充檔 {SP}/revenue_supplement/mops_t21sc03_csv_{YYYY-MM}.{sii|otc}.csv：同站「另存CSV」官方檔
    （POST https://mopsov.twse.com.tw/server-java/FileDownLoad step=9&functionName=show_file2&filePath=/t21/{mk}/&fileName=t21sc03_{民國年}_{月}.csv，
    內容含本國＋外國公司）。只在鏡像缺頁時使用（2026-03 上市 _0／_1 在 MOPS 端是空頁）；鏡像有頁的月份若也有補充檔，
    就逐格對照兩者（不一致即中止）——2026-02 上市實測 1,082 列 0 差異。CSV 的百分比為全精度，向零截斷到 2 位與 HTML 一致。
  · {SP}/revenue.json：兩邊都有的代號一律以 revenue.json 的數值為準（2026-08-10 的較早快照，更正值前視較少），
    數值不同只計數（conflicts）；revenue.json 沒有的代號（KY、晚申報、2022-06～2023-07 歷史）補鏡像值；
    只在 revenue.json 的代號（之後下市、鏡像以現行名單重產而消失者）保留。

晚申報證據（absentAt，epoch ms）：revenue.json 該月是「當期快照」（擷取時刻早於下一個月營收的法定期限＝m+2 月 10 日）
  而本國列（_0 表：sii／otc／sii_csv／otc_csv）不在快照裡 ⇒ 該列在快照當下自家即時管線拿不到。build.revenue_spans 讓這種列
  從「快照日期之後的第一個交易日」才可用（與月可用日取晚者），之前沿用上個月的值。2026-08 實例：快照 2026-09-11 15:14
  （正是嚴格可用日）缺 2880～2892、5880、2816、2832、2850、2851 等 18 檔本國公司 ⇒ 改從 09-14 起可用。
  歷史月份的 revenue.json 是 2026-08-10 的回補（非當期快照），缺列不構成證據、不標；KY（_1 表）revenue.json 從沒抓過，也不標。
  ⚠ 只抓得到「有當期快照證據」的晚申報；歷史月份的金融業若系統性晚於期限，這裡沒有證據可用（待逐日觀測上表時刻後補產業別延遲）。
缺值：上月／去年同月營收為 0 或空白時 MOPS 的增減%是空白 ⇒ 存 None，不填 0。revenue.json 舊回補器把空白填成 0
     （backfill-mops-revenue.mjs num()），合併時還原為 None（上月或去年營收為 0／空白、或鏡像同格為空白者），計數 zeroFixed。

輸出結構同 revenue.json：{月: {month, n, at, bySrc, rows:[{c,n,rev,prev,last,mom,yoy,cum,src[,absentAt]}]}}，另加 pages／valSrc／conflicts／zeroFixed／lateEvidence；
  bySrc＝最終列依「出現在哪一頁」分組：上市／上櫃／上市KY／上櫃KY／revenue.json補（只在 revenue.json）。
  src＝該列數值來源：revenue.json、sii、otc、sii_ky、otc_ky、sii_csv、sii_ky_csv…
  at＝該月所用來源的擷取時刻（epoch ms；鏡像頁 manifest at、補充檔 fetchedAt、revenue.json 的 at 取最大），不是執行時刻。
  稽核明細另寫 {輸出}.report.json（缺頁、衝突逐筆、補充檔對照、只在單一來源的代號數、晚申報證據），以及可追溯的輸入版本 inputs：
  revenue.json 的 sha256、每個鏡像頁的 sha256／擷取時刻／定版規則、每個補充檔的 sha256／擷取時刻；output＝本次輸出檔的 sha256
  （cv_official 分數檔記的月營收 sha256 與它相同 ⇒ 結果可一路追到鏡像頁版本）。
已知殘餘偏差：鏡像歷史頁是 MOPS 以現行名單重產（下市股消失、新上市股帶上市前月份）；2022-06～2023-07 沒有 revenue.json 可補下市股。

用法：SURGE_CACHE=<快取> python3 revenue_official.py [--allow-missing] [--require-stable] [--out <路徑>] [--mirror <official 根目錄>] [--supplement <目錄>]
      鏡像根目錄預設 <repo>/second-brain/official（環境變數 OFFICIAL_ROOT 可覆蓋）；缺頁時中止，除非 --allow-missing。
"""
import csv
import gzip
import hashlib
import io
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN, InvalidOperation

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
SP = os.environ.get('SURGE_CACHE', os.path.join(HERE, '.surge-cache'))
HOST = 'mopsov.twse.com.tw'
SETS = (('mops_t21sc03', ''), ('mops_t21sc03_ky', 'KY'))         # (鏡像資料集, 外國表標記)
MKT = {'sii': '上市', 'otc': '上櫃'}
VALUE_KEYS = ('rev', 'prev', 'last', 'cum')
TR = re.compile(r'<tr[^>]*>([\s\S]*?)</tr>', re.I)
TD = re.compile(r'<td[^>]*>([\s\S]*?)</td>', re.I)
TAG = re.compile(r'<[^>]+>')
TITLE = re.compile(r'(上市|上櫃)公司\s*(\d+)\s*年\s*(\d+)\s*月份')
CODE4 = re.compile(r'\d{4}')
CSV_HEADER = ['出表日期', '資料年月', '公司代號', '公司名稱', '產業別', '營業收入-當月營收', '營業收入-上月營收', '營業收入-去年當月營收',
              '營業收入-上月比較增減(%)', '營業收入-去年同月增減(%)', '累計營業收入-當月累計營收', '累計營業收入-去年累計營收',
              '累計營業收入-前期比較增減(%)', '備註']
BLANK = ('', '-', '--', 'N/A')
TPE = timezone(timedelta(hours=8))
DOMESTIC_SRC = ('sii', 'otc', 'sii_csv', 'otc_csv')               # _0 表（本國）：revenue.json 當期快照涵蓋的範圍


def _int(s):
    s = str(s).replace(',', '').strip()
    if s in BLANK: return None
    try: return int(round(float(s)))
    except ValueError: return None


def _pct_html(s):
    s = str(s).replace(',', '').strip()
    if s in BLANK: return None                                   # 空白（基期為 0）不捏造成 0
    try: return round(float(s), 2)
    except ValueError: return None


def _pct_csv(s):
    s = str(s).replace(',', '').strip()
    if s in BLANK: return None
    try: return float(Decimal(s).quantize(Decimal('0.01'), rounding=ROUND_DOWN))   # HTML 版是向零截斷 2 位
    except InvalidOperation: return None


def _row(code, name, rev, prev, last, mom, yoy, cum, src):
    return dict(c=code, n=name, rev=rev, prev=prev, last=last, mom=mom, yoy=yoy, cum=cum, src=src)


def is_foreign(code, name):
    """CSV 不分表：名稱含 KY（含「-KY創」）或 91xx 存託憑證＝外國發行人（_1 表）。"""
    return 'KY' in name or code.startswith('91')


def parse_html(raw, month, mk, src):
    """鏡像 t21sc03 頁（big5）→ 列；回聲（市場、民國年、月）與單位不符即 raise。"""
    text = raw.decode('big5hkscs', 'replace')
    y, m = int(month[:4]), int(month[5:7])
    t = TITLE.search(text)
    if not t or (t.group(1), int(t.group(2)), int(t.group(3))) != (MKT[mk], y - 1911, m):
        raise ValueError(f'{src} {month} 回聲不符：頁首 {t.group(0) if t else None!r}，應為 {MKT[mk]}公司{y - 1911}年{m}月份')
    if '單位：千元' not in text: raise ValueError(f'{src} {month} 缺「單位：千元」')
    rows = []
    for tr in TR.finditer(text):
        tds = [TAG.sub('', x).replace('&nbsp;', ' ').strip() for x in TD.findall(tr.group(1))]
        if len(tds) < 8 or not CODE4.fullmatch(tds[0]): continue          # 表頭、產業別、合計列
        rev = _int(tds[2])
        if rev is None or rev <= 0: continue                               # 同 backfill-mops-revenue.mjs：無營收不佔位
        rows.append(_row(tds[0], tds[1], rev, _int(tds[3]), _int(tds[4]), _pct_html(tds[5]), _pct_html(tds[6]), _int(tds[7]), src))
    return rows


def parse_csv(raw, month, mk):
    """官方「另存CSV」→ (本國列, 外國列)；表頭與每列「資料年月」須回聲。"""
    text = raw.decode('utf-8-sig')
    y, m = int(month[:4]), int(month[5:7])
    want = f'{y - 1911}/{m}'
    it = csv.reader(io.StringIO(text))
    hdr = next(it, None)
    if hdr != CSV_HEADER: raise ValueError(f'CSV {month}.{mk} 表頭不符：{hdr}')
    dom, fgn = [], []
    for r in it:
        if not r: continue
        if len(r) != len(CSV_HEADER): raise ValueError(f'CSV {month}.{mk} 欄數不符：{r[:4]}')
        if r[1].strip() != want: raise ValueError(f'CSV {month}.{mk} 回聲不符：資料年月 {r[1]!r} ≠ {want}')
        code, name = r[2].strip(), r[3].strip()
        if not CODE4.fullmatch(code): continue
        rev = _int(r[5])
        if rev is None or rev <= 0: continue
        f = is_foreign(code, name)
        row = _row(code, name, rev, _int(r[6]), _int(r[7]), _pct_csv(r[8]), _pct_csv(r[9]), _int(r[10]), f'{mk}{"_ky" if f else ""}_csv')
        (fgn if f else dom).append(row)
    return dom, fgn


def _iso_ms(s):
    return int(datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)


def final_rule(r):
    """manifest 列的定版依據：stable（內容穩定）／clock（舊時鐘規則，final=true 但沒有 finalBy）／None（未定版）。"""
    if r.get('final') is not True: return None
    return 'stable' if r.get('finalBy') == 'stable' else ('clock' if r.get('finalBy') is None else str(r.get('finalBy')))


def load_mirror(root, require_stable=False):
    """{(月, 市場, 標記): (列, 擷取時刻ms)}、略過頁清單、所用頁的出處（sha256／擷取時刻／定版規則）。"""
    pages, skipped, prov = {}, [], []
    for ds, tag in SETS:
        d = os.path.join(root, HOST, ds)
        man_path = os.path.join(d, '_manifest.json')
        if not os.path.isfile(man_path): raise SystemExit(f'找不到鏡像 manifest：{man_path}（--mirror 或 OFFICIAL_ROOT 指到 second-brain/official）')
        with open(man_path) as f: man = json.load(f)['rows']
        for key, r in sorted(man.items()):
            month, mk = key.split('.')
            rule = final_rule(r)
            info = dict(set=ds, key=key, status=r.get('status'), file=r.get('file'), sha256=r.get('sha256'), at=r.get('at'),
                        final=r.get('final'), finalBy=r.get('finalBy'), stableFrom=r.get('stableFrom'), finalRule=rule)
            if r.get('status') == 'empty':
                pages[(month, mk, tag)] = ([], _iso_ms(r['at'])); prov.append(info); continue
            if r.get('status') != 'ok' or rule is None or (require_stable and rule != 'stable'):
                why = '未定版' if rule is None else f'定版規則 {rule}（--require-stable 只收 stable）'
                skipped.append(dict(info, note=r.get('note') or why)); continue
            with gzip.open(os.path.join(d, r['file'])) as f: raw = f.read()
            if hashlib.sha256(raw).hexdigest() != r.get('sha256'):
                raise SystemExit(f'鏡像頁 {ds}/{r["file"]} 解壓後 sha256 與 manifest 記錄不符（檔案壞或被換）——先修鏡像再跑')
            pages[(month, mk, tag)] = (parse_html(raw, month, mk, f'{mk}{"_ky" if tag else ""}'), _iso_ms(r['at']))
            prov.append(info)
    return pages, skipped, prov


def load_supplements(sdir):
    """{(月, 市場): {'dom': 列, 'fgn': 列, 'at': ms, 'file': 名}}；provenance 檔記錄每個 CSV 的擷取時刻與 sha256。"""
    out = {}
    if not os.path.isdir(sdir): return out
    prov_path = os.path.join(sdir, '_provenance.json')
    prov = json.load(open(prov_path))['files'] if os.path.isfile(prov_path) else {}
    for fn in sorted(os.listdir(sdir)):
        mt = re.fullmatch(r'mops_t21sc03_csv_(\d{4}-\d{2})\.(sii|otc)\.csv', fn)
        if not mt: continue
        if fn not in prov: raise SystemExit(f'補充檔 {fn} 沒有 _provenance.json 記錄（來源不明的檔不收）')
        month, mk = mt.groups()
        with open(os.path.join(sdir, fn), 'rb') as f: raw = f.read()
        if hashlib.sha256(raw).hexdigest() != prov[fn]['sha256']: raise SystemExit(f'補充檔 {fn} 的 sha256 與 provenance 不符')
        dom, fgn = parse_csv(raw, month, mk)
        out[(month, mk)] = dict(dom=dom, fgn=fgn, at=_iso_ms(prov[fn]['fetchedAt']), file=fn, sha256=prov[fn]['sha256'],
                                fetchedAt=prov[fn]['fetchedAt'], finalRule='single-observation')
    return out


def supplement_parity(sup, pages):
    """鏡像兩頁都在的 (月, 市場) 若也有補充檔：逐格比對（代號集合＋全部數值欄），回傳摘要；不一致即中止。"""
    res = {}
    for (month, mk), s in sorted(sup.items()):
        if (month, mk, '') not in pages or (month, mk, 'KY') not in pages: continue
        for cls, tag in (('dom', ''), ('fgn', 'KY')):
            a = {r['c']: r for r in s[cls]}; b = {r['c']: r for r in pages[(month, mk, tag)][0]}
            diff = sorted(set(a) ^ set(b))
            bad = [(c, k, a[c][k], b[c][k]) for c in set(a) & set(b) for k in ('rev', 'prev', 'last', 'mom', 'yoy', 'cum') if a[c][k] != b[c][k]]
            res[f'{month}.{mk}.{cls}'] = dict(csv=len(a), mirror=len(b), codeSetDiff=diff[:20], valueMismatch=len(bad))
            if diff or bad: raise SystemExit(f'補充檔 {s["file"]} 與鏡像 {month}.{mk}{"_ky" if tag else ""} 不一致：代號差 {diff[:10]}、數值差 {bad[:5]}')
    return res


def fix_zero(r, mirror_row):
    """revenue.json 的捏造 0 → None。回傳 (新列, 修了幾格)。"""
    out = dict(r); n = 0
    for pk, base in (('yoy', 'last'), ('mom', 'prev')):
        if out.get(pk) != 0: continue
        if not out.get(base) or (mirror_row is not None and mirror_row.get(pk) is None):
            out[pk] = None; n += 1
    return out, n


def next_deadline(month):
    """月營收 month 的下一個月營收法定期限（m+2 月 10 日）。"""
    y, mo = int(month[:4]), int(month[5:7]) + 2
    if mo > 12: y, mo = y + 1, mo - 12
    return f'{y:04d}-{mo:02d}-10'


def snapshot_at(month, legacy_month):
    """revenue.json 該月若是「當期快照」（擷取時刻的台北日期早於 next_deadline），回擷取時刻 ms；回補（事後多月才抓）回 None。"""
    at = (legacy_month or {}).get('at')
    if not at: return None
    day = datetime.fromtimestamp(int(at) / 1000, TPE).strftime('%Y-%m-%d')
    return int(at) if day < next_deadline(month) else None


def merge_month(month, page_rows, page_src, legacy_month):
    """page_rows：{標籤(上市…): 列}；legacy_month：revenue.json 該月（可 None）。回傳 (月文件, 稽核明細)。"""
    mirror, group, dup = {}, {}, 0
    for label, rows in page_rows.items():
        for r in rows:
            if r['c'] in mirror: dup += 1; continue
            mirror[r['c']] = r; group[r['c']] = label
    legacy = {r['c']: r for r in (legacy_month or {}).get('rows', [])}
    out, conflicts, zero_fixed = {}, [], 0
    for c, r in legacy.items():
        m = mirror.get(c)
        row, nz = fix_zero(r, m); zero_fixed += nz
        if m is not None and any(m[k] != r.get(k) for k in VALUE_KEYS):
            conflicts.append(dict(c=c, legacy={k: r.get(k) for k in VALUE_KEYS}, official={k: m[k] for k in VALUE_KEYS}))
        out[c] = _row(c, r.get('n', m['n'] if m else ''), row.get('rev'), row.get('prev'), row.get('last'), row.get('mom'), row.get('yoy'),
                      row.get('cum'), 'revenue.json')
    snap = snapshot_at(month, legacy_month)
    late = []
    for c, m in mirror.items():
        if c in out: continue
        row = dict(m)
        if snap is not None and m['src'] in DOMESTIC_SRC:                  # 當期快照沒有這列本國公司 ⇒ 當時拿不到（晚申報證據）
            row['absentAt'] = snap; late.append(c)
        out[c] = row
    by = {lab: 0 for lab in ('上市', '上櫃', '上市KY', '上櫃KY')}
    by['revenue.json補'] = 0
    for c in out: by[group.get(c, 'revenue.json補')] += 1
    val = {}
    for r in out.values():
        k = 'revenue.json' if r['src'] == 'revenue.json' else ('csv' if r['src'].endswith('_csv') else 'mirror')
        val[k] = val.get(k, 0) + 1
    doc = dict(month=month, n=len(out), bySrc=by, valSrc=val, pages=page_src, conflicts=len(conflicts), zeroFixed=zero_fixed,
               lateEvidence=len(late), rows=sorted(out.values(), key=lambda r: r['c']))
    audit = dict(dup=dup, conflicts=conflicts, zeroFixed=zero_fixed, mirrorOnly=sum(1 for c in mirror if c not in legacy),
                 legacyOnly=sorted(c for c in legacy if c not in mirror),
                 snapshotAt=(datetime.fromtimestamp(snap / 1000, TPE).isoformat() if snap else None), lateEvidence=sorted(late))
    return doc, audit


def build(root, sdir, legacy, allow_missing, require_stable=False):
    pages, skipped, page_prov = load_mirror(root, require_stable)
    sup = load_supplements(sdir)
    parity = supplement_parity(sup, pages)
    # 應有月份＝收到的頁∪revenue.json∪「被略過的頁」中不晚於最後一個有資料月份者——歷史月份的頁全被略過（未定版、--require-stable）
    # 也要算缺頁而中止，不可整月悄悄消失；晚於最後有資料月份的（申報期內的當月）才放掉。
    used = {m for (m, _, _) in pages} | set(legacy)
    last_used = max(used) if used else ''
    months = sorted(used | {x['key'].split('.')[0] for x in skipped if x['key'].split('.')[0] <= last_used})
    out, audit, missing_all, used_sup = {}, {}, [], []
    for m in months:
        page_rows, page_src, ats, miss = {}, {}, [], []
        for mk in MKT:
            for _, tag in SETS:
                label = MKT[mk] + tag
                if (m, mk, tag) in pages:
                    rows, at = pages[(m, mk, tag)]; page_rows[label] = rows; page_src[label] = 'mirror'; ats.append(at)
                elif (m, mk) in sup:
                    s = sup[(m, mk)]; page_rows[label] = s['fgn' if tag else 'dom']; page_src[label] = 'csv'; ats.append(s['at'])
                    used_sup.append(f'{m}.{mk}{"_ky" if tag else ""}←{s["file"]}')
                else:
                    page_src[label] = 'missing'; miss.append(f'{mk}{"_ky" if tag else ""}')
        if miss: missing_all.append(f'{m}:{",".join(miss)}')
        if miss and not allow_missing:
            sk = [f"{x['set']}/{x['key']}:{x['note']}" for x in skipped if x['key'].startswith(m + '.')]
            raise SystemExit(f'{m} 缺頁 {miss}；該月略過的頁 {sk or "無"}（鏡像回補未完成或頁未定版——revenue-ky 的內容穩定定版需相隔 ≥3 日兩次相同觀測；'
                             f'等定版完成再跑，或確定要放行才加 --allow-missing）')
        lm = legacy.get(m)
        if lm and lm.get('at'): ats.append(int(lm['at']))
        doc, au = merge_month(m, page_rows, page_src, lm)
        out[m] = dict(month=doc['month'], n=doc['n'], at=max(ats) if ats else None, **{k: v for k, v in doc.items() if k not in ('month', 'n')})
        audit[m] = dict(missingPages=miss, **au)
    rules = {}
    for x in page_prov: rules[x['finalRule'] or x['status']] = rules.get(x['finalRule'] or x['status'], 0) + 1
    sup_prov = [dict(file=s['file'], sha256=s['sha256'], fetchedAt=s['fetchedAt'], finalRule=s['finalRule']) for s in sup.values()]
    report = dict(months=len(out), first=min(out), last=max(out), skippedPages=skipped, missingPages=missing_all, supplementUsed=used_sup,
                  supplementParity=parity, conflictsTotal=sum(len(a['conflicts']) for a in audit.values()),
                  zeroFixedTotal=sum(a['zeroFixed'] for a in audit.values()),
                  lateEvidenceTotal=sum(len(a['lateEvidence']) for a in audit.values()), requireStable=bool(require_stable),
                  finalRuleCounts=rules, inputs=dict(pages=page_prov, supplements=sup_prov), perMonth=audit)
    return out, report


def write_json_atomic(path, obj, compact):
    tmp = f'{path}.tmp{os.getpid()}'
    with open(tmp, 'w', encoding='utf-8') as f:
        if compact: json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        else: json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def main():
    argv = sys.argv[1:]
    opt = lambda k, d: argv[argv.index(k) + 1] if k in argv else d
    root = opt('--mirror', os.environ.get('OFFICIAL_ROOT', os.path.join(REPO, 'second-brain', 'official')))
    sdir = opt('--supplement', os.path.join(SP, 'revenue_supplement'))
    out_path = opt('--out', os.path.join(SP, 'revenue_official.json'))
    legacy_path = os.path.join(SP, 'revenue.json')
    with open(legacy_path, 'rb') as f: legacy_raw = f.read()
    legacy = json.loads(legacy_raw)
    out, rep = build(root, sdir, legacy, '--allow-missing' in argv, '--require-stable' in argv)
    write_json_atomic(out_path, out, compact=True)
    with open(out_path, 'rb') as f: out_sha = hashlib.sha256(f.read()).hexdigest()
    rep['inputs']['revenueJson'] = dict(file=legacy_path, sha256=hashlib.sha256(legacy_raw).hexdigest(), months=len(legacy))
    rep['inputs']['mirrorRoot'] = root
    rep['output'] = dict(file=out_path, sha256=out_sha)
    rep_path = os.path.splitext(out_path)[0] + '.report.json'
    write_json_atomic(rep_path, rep, compact=False)
    print(f'月份 {rep["months"]}（{rep["first"]}～{rep["last"]}）→ {out_path}')
    print(f'  略過頁（未定版／壞頁）{[(s["set"], s["key"], s["status"]) for s in rep["skippedPages"]]}')
    print(f'  官方補充檔使用 {rep["supplementUsed"]}；補充檔對照 {rep["supplementParity"]}')
    print(f'  缺頁 {rep["missingPages"] or "無"}；數值衝突（以 revenue.json 為準）{rep["conflictsTotal"]} 筆；捏造 0 還原 None {rep["zeroFixedTotal"]} 格')
    print(f'  鏡像頁定版規則 {rep["finalRuleCounts"]}（clock＝舊時鐘規則；--require-stable {"開" if rep["requireStable"] else "關"}）')
    late = {m: a['lateEvidence'] for m, a in rep['perMonth'].items() if a['lateEvidence']}
    print(f'  晚申報證據（當期快照沒有的本國列，標 absentAt）共 {rep["lateEvidenceTotal"]} 列：' +
          '；'.join(f'{m}@{rep["perMonth"][m]["snapshotAt"][:16]} {len(v)} 檔' for m, v in late.items()))
    print(f'  輸出 sha256 {out_sha[:16]}；revenue.json sha256 {rep["inputs"]["revenueJson"]["sha256"][:16]}')
    for m in sorted(out):
        d = out[m]
        if m in (rep['first'], '2023-07', '2023-08', '2026-03', rep['last']) or d['conflicts'] or 'missing' in d['pages'].values():
            print(f'  {m} n={d["n"]} bySrc={d["bySrc"]} valSrc={d["valSrc"]} pages={d["pages"]} 衝突 {d["conflicts"]}')
    print(f'  稽核明細 → {rep_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
