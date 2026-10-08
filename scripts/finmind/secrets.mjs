// ── FinMind token 讀取與遮罩（2026-10-08）──────────────────────────────────────
// 規矩：token 絕不印出、不寫進指令字串／日誌／檔案／錯誤訊息；執行時才從 .env.local 讀，只放 Authorization: Bearer 標頭。
//   ① .env.local 可能有多行 FINMIND_TOKEN（2026-10-08 實測曾有 3 行：181／0／92 字元，只有第一行是 Sponsor）
//      ⇒ 不用 dotenv 的「最後一行勝出」，全部列為候選、用 user_info 驗 level，選中後只記「第幾行」。
//   ② FinMind 的錯誤回應會回聲 token 末 8 碼（token_tail 欄位）⇒ 落地、記錄、回報前一律抹除。
import { readFileSync } from 'node:fs';

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
const DROP_KEY = /^(token|token_tail|api_token|authorization)$/i;
const MIN_SECRET_LEN = 16;   // 短字串不當秘密遮（避免把一般內容誤遮）
const TAIL_LEN = 8;

function unquote(v) {
  if (/^["']/.test(v)) {
    const q = v[0]; const end = v.indexOf(q, 1);
    return end > 0 ? v.slice(1, end) : v.slice(1);
  }
  return v.replace(/\s+#.*$/, '').trim();
}

/** 解析 .env 文字：回傳 { candidates:[{line,value}], empty:[行號] }（照檔案順序，註解行略過）。 */
export function parseEnvCandidates(text, key = 'FINMIND_TOKEN') {
  const candidates = []; const empty = [];
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return;
    const m = raw.match(LINE_RE);
    if (!m || m[1] !== key) return;
    const v = unquote(m[2]);
    if (v) candidates.push({ line: i + 1, value: v }); else empty.push(i + 1);
  });
  return { candidates, empty };
}

/** 從檔案讀候選。讀不到時錯誤只講路徑。 */
export function readTokenCandidates(envPath, key = 'FINMIND_TOKEN') {
  let text;
  try { text = readFileSync(envPath, 'utf8'); } catch (e) { throw new Error(`讀不到 ${envPath}（${e.code || 'error'}）`); }
  return parseEnvCandidates(text, key);
}

/** 給日誌用的候選描述：只有行號與長度。 */
export function describeCandidates(candidates) {
  return candidates.map(c => ({ line: c.line, length: String(c.value).length }));
}

/** 遮罩：完整 token、token 末 8 碼、Bearer 標頭、token／token_tail 欄位與 URL 參數。 */
export function maskSecrets(text, secrets = []) {
  let s = String(text ?? '');
  for (const sec of secrets) {
    if (!sec || String(sec).length < MIN_SECRET_LEN) continue;
    s = s.split(String(sec)).join('***');
    s = s.split(String(sec).slice(-TAIL_LEN)).join('***');
  }
  s = s.replace(/(Bearer\s+)[^\s"',;]+/gi, '$1***');
  s = s.replace(/("token(?:_tail)?"\s*:\s*")[^"]*(")/gi, '$1***$2');
  s = s.replace(/([?&]token=)[^&\s"']+/gi, '$1***');
  return s;
}

/** 深拷貝並刪除敏感鍵、字串值再遮罩（不改原物件）。 */
export function scrubBody(value, secrets = []) {
  if (Array.isArray(value)) return value.map(v => scrubBody(v, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!DROP_KEY.test(k)) out[k] = scrubBody(v, secrets);
    return out;
  }
  return typeof value === 'string' ? maskSecrets(value, secrets) : value;
}

/**
 * 依序以 verify(token) 驗證候選，選第一個 level ≥ minLevel 的。
 * verify 回 { ok, http, level, info }。回傳 { token, line, level, info, rejected }；rejected 只有行號／長度／http／level。
 */
export async function chooseToken(candidates, verify, { minLevel = 3 } = {}) {
  if (!candidates?.length) throw new Error('.env.local 找不到 FINMIND_TOKEN');
  const all = candidates.map(c => c.value);
  const rejected = [];
  for (const c of candidates) {
    let r;
    try { r = await verify(c.value); } catch (e) { r = { ok: false, http: null, level: null, error: maskSecrets(e?.message || e, all) }; }
    const level = r?.level == null ? null : Number(r.level);
    if (r?.ok && level >= minLevel) return { token: c.value, line: c.line, level, info: r.info ?? null, rejected };
    rejected.push({ line: c.line, length: String(c.value).length, http: r?.http ?? null, level, ...(r?.error ? { error: r.error } : {}) });
  }
  const why = rejected.map(x => `第 ${x.line} 行（長度 ${x.length}）http=${x.http ?? '—'} level=${x.level ?? '—'}${x.error ? ` ${x.error}` : ''}`).join('；');
  throw new Error(maskSecrets(`沒有 level≥${minLevel} 的 FINMIND_TOKEN 候選：${why}`, all));
}
