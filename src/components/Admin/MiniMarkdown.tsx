'use client';

// 研究分析文件的極簡 Markdown 顯示：標題、引言、表格、清單、段落＋行內 **粗體**／`程式碼`。
// 全部以 React 文字節點輸出（不用 dangerouslySetInnerHTML），內容來自研究輸出也不會被當成 HTML 執行。
import type { ReactNode } from 'react';

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'quote'; lines: string[] }
  | { t: 'table'; rows: string[][] }
  | { t: 'list'; ordered: boolean; items: string[] }
  | { t: 'p'; text: string };

const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
const isSep = (l: string) => /^\s*\|?\s*:?-{2,}/.test(l) && /^[\s|:-]+$/.test(l);

function parse(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { out.push({ t: 'h', level: h[1].length, text: h[2] }); continue; }
    if (l.startsWith('>')) {
      const q: string[] = [];
      for (; i < lines.length && lines[i].startsWith('>'); i++) q.push(lines[i].replace(/^>\s?/, ''));
      i--; out.push({ t: 'quote', lines: q }); continue;
    }
    if (l.trim().startsWith('|')) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i].trim().startsWith('|'); i++) if (!isSep(lines[i])) rows.push(cells(lines[i]));
      i--; out.push({ t: 'table', rows }); continue;
    }
    const li = /^\s*(-|\d+\.)\s+(.*)$/.exec(l);
    if (li) {
      const ordered = li[1] !== '-'; const items: string[] = [];
      for (; i < lines.length; i++) {
        const m = /^\s*(-|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m && (m[1] !== '-') === ordered) items.push(m[2]);
        else if (lines[i].startsWith('  ') && items.length && lines[i].trim()) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
      }
      i--; out.push({ t: 'list', ordered, items }); continue;
    }
    out.push({ t: 'p', text: l });
  }
  return out;
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((s, i) => {
    if (s.startsWith('**') && s.endsWith('**') && s.length > 4) return <b key={i}>{s.slice(2, -2)}</b>;
    if (s.startsWith('`') && s.endsWith('`') && s.length > 2) return <code key={i} style={{ fontSize: '0.92em', padding: '0 3px', borderRadius: 4, background: 'var(--bg-tertiary)' }}>{s.slice(1, -1)}</code>;
    return <span key={i}>{s}</span>;
  });
}

export default function MiniMarkdown({ md }: { md: string }) {
  const blocks = parse(md);
  return (
    <div style={{ fontSize: 'calc(13px * var(--fz))', lineHeight: 1.7, overflowWrap: 'anywhere' }}>
      {blocks.map((b, k) => {
        if (b.t === 'h') return <div key={k} style={{ fontWeight: 900, fontSize: `calc(${b.level <= 1 ? 16 : b.level === 2 ? 14.5 : 13.5}px * var(--fz))`, margin: '12px 0 4px' }}>{inline(b.text)}</div>;
        if (b.t === 'quote') return <div key={k} style={{ borderLeft: '3px solid var(--border-primary)', padding: '2px 10px', color: 'var(--text-muted)', margin: '6px 0' }}>{b.lines.map((x, i) => <div key={i}>{inline(x)}</div>)}</div>;
        if (b.t === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return <Tag key={k} style={{ margin: '4px 0', paddingLeft: 22 }}>{b.items.map((x, i) => <li key={i}>{inline(x)}</li>)}</Tag>;
        }
        if (b.t === 'table') {
          const [head, ...rows] = b.rows;
          return (
            <div key={k} style={{ overflowX: 'auto', margin: '6px 0', border: '1px solid var(--border-primary)', borderRadius: 8 }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 'calc(12.5px * var(--fz))', minWidth: '100%' }}>
                {head && <thead><tr>{head.map((c, i) => <th key={i} style={{ padding: '4px 8px', textAlign: 'left', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-primary)', whiteSpace: 'nowrap' }}>{inline(c)}</th>)}</tr></thead>}
                <tbody>{rows.map((r, j) => <tr key={j} style={{ borderBottom: '1px dashed var(--border-primary)' }}>{r.map((c, i) => <td key={i} style={{ padding: '4px 8px', verticalAlign: 'top', minWidth: i === 0 ? undefined : '8em' }}>{inline(c)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        }
        return <p key={k} style={{ margin: '4px 0' }}>{inline(b.text)}</p>;
      })}
    </div>
  );
}
