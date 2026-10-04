'use client';

// 🤖 AI 實驗（超級管理員）：當沖（盤中 Ollama 審核工作台觸發）／波段持有（盤後 Ollama 從波段榜選股）／起漲影子名單（研究模型盤後凍結）
import { useState } from 'react';
import AiDaytradeLab from './AiDaytradeLab';
import AiSwingLab from './AiSwingLab';
import AiLabTargets from './AiLabTargets';
import AiLabLearn from './AiLabLearn';
import SurgeShadow from './SurgeShadow';

type Kind = 'daytrade' | 'swing' | 'surge';
const KINDS: ReadonlyArray<readonly [Kind, string]> = [['daytrade', '⏳ 當沖'], ['swing', '🌊 波段持有'], ['surge', '🚀 起漲影子']];

function Tabs({ kind, setKind }: { kind: Kind; setKind: (k: Kind) => void }) {
  return (
    <div role="tablist" style={{ display: 'inline-flex', flexWrap: 'wrap', padding: 2, borderRadius: 999, background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)', marginBottom: 10 }}>
      {KINDS.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
          style={{ padding: '3px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 'calc(12.5px * var(--fz))', background: kind === k ? 'rgba(125,211,252,0.18)' : 'transparent', color: kind === k ? '#7dd3fc' : 'var(--text-muted)' }}>{l}</button>
      ))}
    </div>
  );
}

export default function AiLabHub() {
  const [kind, setKind] = useState<Kind>('daytrade');
  // 起漲影子名單是研究模型的獨立實驗，不套 AI 實驗的目標追蹤與學習面板
  if (kind === 'surge') return <div><Tabs kind={kind} setKind={setKind} /><SurgeShadow /></div>;
  return (
    <div>
      <AiLabTargets />
      <Tabs kind={kind} setKind={setKind} />
      {kind === 'daytrade' ? <AiDaytradeLab /> : <AiSwingLab />}
      <AiLabLearn />
    </div>
  );
}
