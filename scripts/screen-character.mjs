#!/usr/bin/env node
// 專家混合前測：實證因子×股票性格（炒作型/一般/長期核心）分組有效性
// ⚠分類為當前3年窗計算（慢變數），與回測期重疊屬近似——結論僅用於「是否值得分權重」的方向判斷。
import admin from 'firebase-admin';
import { loadDays, buildSamples, report } from './lib/bt-core.mjs';
const days = await loadDays({ days: 700 });
const samples = buildSamples(days);
const db = admin.firestore();
const by = JSON.parse((await db.collection('chipCharacter').doc('latest').get()).data().byCodeJson);
for (const s of samples) s.char = by[s.code]?.label || null;
const n = { 炒作型: 0, 一般: 0, 長期核心: 0 };
for (const s of samples) if (s.char) n[s.char]++;
console.log(`樣本 ${samples.length.toLocaleString()}·炒作型 ${n.炒作型.toLocaleString()}/一般 ${n.一般.toLocaleString()}/長期核心 ${n.長期核心.toLocaleString()}`);

for (const ch of ['炒作型', '一般', '長期核心']) {
  report(samples.filter(s => s.char === ch), { title: `【${ch}】核心因子有效性`, minN: 200, groups: [
    { label: '破高×強尾', cond: s => s.brk20 && s.pos >= 0.7 },
    { label: '定版濾網(×3~7)', cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 },
    { label: '過熱 ret5≥20', cond: s => s.ret5 != null && s.ret5 >= 20 },
    { label: '強尾單獨', cond: s => s.pos >= 0.8 && Math.abs(s.chg) > 1 && !(s.brk20 && s.pos >= 0.7) },
  ] });
}
process.exit(0);
