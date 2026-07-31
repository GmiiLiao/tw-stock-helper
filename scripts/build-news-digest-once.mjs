// 一次性種子：手動產出當日 newsDigest（與 daemon buildNewsDigest 同管線）。
// 平日由 daemon 07:00 自動發布；此腳本用於初次上線種子或當日補發。
// 用法：node scripts/build-news-digest-once.mjs
import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwythos-9b:q8_0';
const today = (() => { const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; })();

const NEWS_CATS = [
  { key: 'aiGlobal', label: '🤖 全球 AI 產業', q: ['AI 晶片 產業', 'OpenAI OR Anthropic OR AI模型', '人工智慧 資料中心 投資'] },
  { key: 'world', label: '🌍 全球局勢', q: ['聯準會 OR 美國經濟', '地緣政治 中美 OR 台海', '國際股市 歐洲 OR 日本'] },
  { key: 'usFab', label: '🏗️ 美國建廠·NVIDIA 供應鏈', q: ['台積電 美國 建廠 OR 亞利桑那', 'NVIDIA 供應鏈 OR 合作夥伴', '輝達 出貨 OR 生產進度'] },
  { key: 'taiwan', label: '🇹🇼 台灣產業', q: ['台灣 半導體 產業', '台灣 電子業 營收 OR 展望', '台股 產業 動態'] },
];

async function rss(query, cap = 8) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal }).finally(() => clearTimeout(tm));
    if (!r.ok) return [];
    const xml = await r.text();
    const items = []; const re = /<item>([\s\S]*?)<\/item>/g; let m;
    const unesc = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    while ((m = re.exec(xml)) && items.length < cap) {
      const b = m[1];
      const pick = tag => { const mm = b.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)); return mm ? mm[1].trim() : ''; };
      const title = unesc(pick('title')); const link = pick('link'); const pub = pick('pubDate');
      const src = unesc((b.match(/<source[^>]*>([^<]+)<\/source>/) || [])[1] || '');
      if (title) items.push({ title, link, src, at: pub ? new Date(pub).getTime() : 0 });
    }
    return items;
  } catch { return []; }
}

async function ollama(prompt) {
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 120000);
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }), signal: ctl.signal,
    }).finally(() => clearTimeout(tm));
    if (!r.ok) return '';
    return ((await r.json()).response || '').trim();
  } catch { return ''; }
}

const cats = [];
for (const cat of NEWS_CATS) {
  const seen = new Set(); const items = [];
  for (const q of cat.q) {
    for (const it of await rss(q, 8)) {
      const key = it.title.replace(/[\s\-|｜–—「」()（）]/g, '').slice(0, 24);
      if (seen.has(key)) continue; seen.add(key); items.push(it);
    }
    await sleep(400);
  }
  const FRESH_MS = 36 * 3600 * 1000, now = Date.now();
  const fresh = items.filter(t => !t.at || now - t.at <= FRESH_MS);
  const pool = fresh.length >= 3 ? fresh : items;
  pool.sort((a, b) => b.at - a.at);
  const top = pool.slice(0, 8);
  let brief = '';
  if (top.length >= 3) {
    brief = (await ollama(`你是財經編輯。根據下列今日新聞標題，用繁體中文寫 2~3 句「${cat.label.replace(/^\S+\s/, '')}」重點導讀。只根據標題歸納共同趨勢，不可編造標題沒有的細節，不要條列、不要加標題。\n${top.map(t => '· ' + t.title).join('\n')}`)).slice(0, 400);
  }
  cats.push({ key: cat.key, label: cat.label, brief, items: top.map(t => ({ title: t.title, link: t.link, src: t.src, at: t.at })) });
  console.log(`${cat.key}: ${top.length} 則·導讀 ${brief ? brief.length + '字' : '無'}`);
}
const total = cats.reduce((s, c) => s + c.items.length, 0);
if (total < 5) { console.log('來源近乎空，不寫入'); process.exit(1); }
const newest = Math.max(0, ...cats.flatMap(c => c.items.map(i => i.at || 0)));
const doc = { date: today, updatedAt: Date.now(), newestAt: newest || null, cats, note: '來源：Google News 各媒體標題（連結導回原媒體）·AI 導讀僅歸納標題·非投資建議' };
await db.collection('newsDigest').doc(today).set(doc);
await db.collection('newsDigest').doc('latest').set(doc);
console.log(`✓ 每日新聞 ${today} 共 ${total} 則`);
process.exit(0);
