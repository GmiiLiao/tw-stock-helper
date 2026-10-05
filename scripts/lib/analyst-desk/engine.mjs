// ─────────────────────────────────────────────────────────────────────────────
// 分析師團隊：引擎轉接層。LLM 只是「被呼叫的函式」，寫入／查核／降級由 desk.mjs 的程式握有。
//   claude-cli  無頭 `claude -p`（用使用者已登入的帳號；--tools "" 不給任何工具、--setting-sources "" 不載入
//               CLAUDE.md／記憶／外掛，實測單次約 150 tokens 起跳，不是 37k）；prompt 走 stdin。
//               401／OAuth 過期 → 拋 EngineAuthError（desk 以此降級並寫 _alerts，不重試）。
//   ollama      本機 Ollama（第二層；呼叫前須確認 daemon 不忙，見 ollamaFree()）。
//   files       讀 {dir}/{role}.json（開發、乾跑、人工補稿；子代理可代寫）。
//   template    不呼叫模型（desk 直接走 narrative.mjs 模板版）。
//   不使用 API 金鑰、不寫任何金鑰到檔案或日誌。
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ENGINES = ['claude-cli', 'ollama', 'files', 'template'];
export const DEFAULT_MODEL = { claude: 'opus', ollama: process.env.OLLAMA_MODEL || 'gemma4:latest' };
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

export class EngineAuthError extends Error { constructor(m) { super(m); this.name = 'EngineAuthError'; } }
export class EngineError extends Error { constructor(m, extra = {}) { super(m); this.name = 'EngineError'; Object.assign(this, extra); } }

const AUTH_RE = /401|authenticat|oauth|token (has )?expired|not logged in|please run \/login|invalid api key/i;

/** 從模型文字取出第一個完整 JSON 物件（容忍 ```json 柵欄與前後說明）；失敗回 null。 */
export function extractJson(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cand = fence ? fence[1] : s;
  const start = cand.search(/[{[]/);
  if (start < 0) return null;
  const open = cand[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cand.length; i++) {
    const c = cand[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try { return JSON.parse(cand.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function runClaudeCli({ system, user, model, effort, timeoutMs, bin = process.env.CLAUDE_BIN || 'claude' }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence',
      '--setting-sources', '', '--disable-slash-commands', '--strict-mcp-config',
      '--model', model, ...(effort ? ['--effort', effort] : []), '--system-prompt', system];
    const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: process.env.TMPDIR || '/tmp' });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => { if (!done) { done = true; p.kill('SIGKILL'); reject(new EngineError(`claude-cli 逾時 ${timeoutMs}ms`, { code: 'timeout' })); } }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { if (!done) { done = true; clearTimeout(timer); reject(new EngineError(`claude-cli 無法啟動：${e.message}`, { code: 'spawn' })); } });
    p.on('close', code => {
      if (done) return; done = true; clearTimeout(timer);
      let j = null; try { j = JSON.parse(out); } catch { /* 下方統一處理 */ }
      const blob = `${out.slice(0, 600)} ${err.slice(0, 600)}`;
      if (j?.is_error || code !== 0 || !j) {
        if (AUTH_RE.test(blob) || j?.api_error_status === 401) return reject(new EngineAuthError('claude-cli 未登入或 OAuth 已過期，需使用者重新登入'));
        return reject(new EngineError(`claude-cli 失敗（exit ${code}）：${(j?.result || err || out).toString().slice(0, 300)}`, { code: 'exit' }));
      }
      const modelUsed = Object.keys(j.modelUsage || {})[0] || model;
      resolve({ text: String(j.result ?? ''), model: modelUsed, usage: { in: (j.usage?.input_tokens ?? 0) + (j.usage?.cache_creation_input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0), out: j.usage?.output_tokens ?? 0, costUsd: j.total_cost_usd ?? null } });
    });
    p.stdin.end(user);
  });
}

/** Ollama 是否空閒（daemon 的 .signals/llm.json）；忙就讓路，不插隊。 */
export function ollamaFree(signalsDir = join(process.cwd(), 'second-brain', '.signals')) {
  try {
    const f = join(signalsDir, 'llm.json');
    if (!existsSync(f)) return true;
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return !j.busy && !(j.queue > 0);
  } catch { return true; }
}

async function runOllama({ system, user, model, timeoutMs, json }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ model, stream: false, ...(json ? { format: 'json' } : {}), options: { temperature: 0.2 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!r.ok) throw new EngineError(`ollama HTTP ${r.status}`, { code: 'http' });
    const j = await r.json();
    return { text: String(j.message?.content ?? ''), model, usage: { in: j.prompt_eval_count ?? 0, out: j.eval_count ?? 0, costUsd: 0 } };
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError(`ollama 失敗：${e.name === 'AbortError' ? '逾時' : e.message}`, { code: e.name === 'AbortError' ? 'timeout' : 'net' });
  } finally { clearTimeout(t); }
}

function runFiles({ role, dir, round }) {
  if (!dir) throw new EngineError('files 引擎需要 --files-dir', { code: 'config' });
  const names = [round ? `${role}.${round}.json` : `${role}.json`];   // 指定輪次就只認該輪檔，不退回 R1 稿
  for (const n of names) {
    const f = join(dir, n);
    if (existsSync(f)) return { text: readFileSync(f, 'utf8'), model: `files:${n}`, usage: { in: 0, out: 0, costUsd: 0 } };
  }
  throw new EngineError(`files 引擎找不到 ${names.join('／')}（目錄 ${dir}；現有：${existsSync(dir) ? readdirSync(dir).join(',') : '目錄不存在'}）`, { code: 'missing' });
}

/**
 * callModel({ engine, role, system, user, round?, json?, timeoutMs?, model?, filesDir? })
 *   → { text, json|null, model, usage:{in,out,costUsd} }
 * json:true（預設）會嘗試 extractJson；解析失敗 json=null（呼叫端決定是否重試）。
 */
export async function callModel(opts) {
  const { engine, role, system = '', user = '', round, json = true, timeoutMs = 240000, filesDir } = opts;
  let r;
  if (engine === 'claude-cli') r = await runClaudeCli({ system, user, model: opts.model || DEFAULT_MODEL.claude, effort: opts.effort, timeoutMs, bin: opts.bin });
  else if (engine === 'ollama') r = await runOllama({ system, user, model: opts.model || DEFAULT_MODEL.ollama, timeoutMs, json });
  else if (engine === 'files') r = runFiles({ role, dir: filesDir, round });
  else throw new EngineError(`未知或不可呼叫的引擎：${engine}`, { code: 'config' });
  return { ...r, json: json ? extractJson(r.text) : null };
}
