// 重啟前的「上游故障中」掃描（2026-10-03）：daemon 有些後備是**程序記憶體**的 stale-if-error 快取，
//   上游故障期間重啟＝快取蒸發。實案：本機 DNS 解析不到 www.tpex.org.tw，13:50 重啟後全站上櫃整批消失。
//   掃 daemon 日誌最近 windowMs 內的「正在靠快取／後備撐著」訊息；有就不該重啟（除非明確 --ack-outage）。
export const OUTAGE_RE = /stale-if-error|沿用上一份快取|完全無來源|改用本地備份|宇宙殘缺|鏡像重試 \d+ 次仍失敗/;

/** 日誌全文 → 最近 windowMs 內符合 re 的行（行首須為 ISO 時間戳） */
function recentLines(text, nowMs, windowMs, re) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (nowMs - t <= windowMs && t <= nowMs + 60000 && re.test(line)) out.push(line);
  }
  return out;
}

/** 日誌全文 → 最近 windowMs 內符合故障字樣的行（行首須為 ISO 時間戳）。can-restart-daemon 用：只要 daemon 正靠快取／後備撐著就擋重啟。 */
export function recentOutageLines(text, nowMs, windowMs = 15 * 60000) {
  return recentLines(text, nowMs, windowMs, OUTAGE_RE);
}

// ── 官方鏡像的開跑閘門（2026-10-08·WP7）────────────────────────────────────
// 舊版鏡像沿用上面的 OUTAGE_RE：近 30 分鐘有任何一行就整個不跑。但 daemon 的上櫃 openapi
// （tpex_mainboard_daily_close_quotes，4.7MB 未壓縮）自 08-30 起在 TPEx 端幾乎每次都被中途切斷（terminated／逾時），
// daemon 每 ~10 分鐘重抓一次、帶日期端點後備多半成功——這是「單一大檔傳輸失敗」不是「上游在擋我們」，
// 卻讓鏡像 10-06、10-07 的 daily 與 10-07、10-08 的 retry 全被擋（三個機構一起停）。
// 新規則：
//   ① 封鎖／限流訊號（HTTP 30x／401／403／429、封鎖頁、請求過於頻繁…）才擋，而且只擋該機構家族；
//      認不出家族的封鎖行 ⇒ 全部家族都擋（保守）。封鎖行不一定含 OUTAGE_RE 字樣（例：BWIBBU rwd HTTP 307），所以另外掃。
//   ② 其餘故障行（傳輸中斷、逾時、靠快取撐著）只標「降級」：該家族照跑，由鏡像佇列自己的保護處理
//      （封鎖訊號立即停、5xx／網路錯誤退避重試一次、連續 3 次失敗停）。
//   ③ 30 分鐘內沒有新的封鎖行 ⇒ 自動恢復。
export const BLOCK_SIGNAL_RE = /HTTP (?:30[1-8]|401|403|429)\b|封鎖|限流|請求過於頻繁|SECURITY REASONS|因為安全性考量|Too Many Requests|Access Denied|拒絕存取|驗證碼|captcha/i;
const FAMILY_RES = [
  ['tpex', /上櫃|櫃買|TPEx|tpex|otc=false/],
  ['twse', /上市|證交所|STOCK_DAY_ALL|TWSE|twse|BWIBBU|MI_INDEX|MI_MARGN|T86|TWT\d|rwd|借券可賣|tse=false/],
  ['taifex', /期交所|taifex|TAIFEX/],
];
/** 一行故障訊息 → 受影響的機構家族（同鏡像 familyOf 的命名：twse／tpex／taifex）；認不出 ⇒ ['*']（全部家族）。 */
export function outageFamiliesOf(line) {
  const out = FAMILY_RES.filter(([, re]) => re.test(String(line))).map(([f]) => f);
  return out.length ? out : ['*'];
}
const groupByFamily = lines => {
  const m = {};
  for (const l of lines) for (const f of outageFamiliesOf(l)) (m[f] ||= []).push(l);
  return m;
};
/**
 * 鏡像開跑閘門：日誌全文 → { blocked: {家族: [行]}, degraded: {家族: [行]} }。
 * blocked＝近 windowMs 有封鎖／限流訊號（該家族本次不跑；'*'＝全部不跑）；degraded＝其餘故障字樣（照跑，只記錄）。
 */
export function mirrorOutageGate(text, nowMs, windowMs = 30 * 60000) {
  // 只認 daemon 的警示／錯誤行（⚠／✗／✖ 開頭的那類）：新聞標題等一般行裡的「封鎖」字樣不算上游封鎖
  const blockLines = recentLines(text, nowMs, windowMs, BLOCK_SIGNAL_RE).filter(l => /[⚠✗✖]/.test(l));
  const blockSet = new Set(blockLines);
  const degradedLines = recentOutageLines(text, nowMs, windowMs).filter(l => !blockSet.has(l));
  return { blocked: groupByFamily(blockLines), degraded: groupByFamily(degradedLines) };
}
