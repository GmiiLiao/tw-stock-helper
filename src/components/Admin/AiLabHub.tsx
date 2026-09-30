'use client';

// 🤖 AI 實驗（超級管理員）：當沖（盤中 Ollama 審核工作台觸發）／波段持有（盤後 Ollama 從波段榜選股）
import { useState } from 'react';
import AiDaytradeLab from './AiDaytradeLab';
import AiSwingLab from './AiSwingLab';
import AiLabTargets from './AiLabTargets';
import AiLabLearn from './AiLabLearn';

export default function AiLabHub() {
  const [kind, setKind] = useState<'daytrade' | 'swing'>('daytrade');
  return (
    <div>
      <AiLabTargets />
      <div role="tablist" style={{ display: 'inline-flex', padding: 2, borderRadius: 999, background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)', marginBottom: 10 }}>
        {([['daytrade', '⏳ 當沖'], ['swing', '🌊 波段持有']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
            style={{ padding: '3px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 'calc(12.5px * var(--fz))', background: kind === k ? 'rgba(125,211,252,0.18)' : 'transparent', color: kind === k ? '#7dd3fc' : 'var(--text-muted)' }}>{l}</button>
        ))}
      </div>
      {kind === 'daytrade' ? <AiDaytradeLab /> : <AiSwingLab />}
      <AiLabLearn />
    </div>
  );
}
