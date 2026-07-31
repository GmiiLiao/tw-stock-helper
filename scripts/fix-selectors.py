#!/usr/bin/env python3
"""
把 `const { a, b } = useAppStore();` 改成有 selector 的版本。

為什麼要改：zustand v5 在沒有 selector 時會比對整個 state 物件，
任何一次 set() 都讓該元件重繪。而 Header.tsx:95 每 2 分鐘 setAllStocks()，
page.tsx 又是整棵 App 的入口 —— 全專案 React.memo 使用次數是 0，
所以沒有任何一層攔得住這個重繪。

轉換規則（刻意保守，看不懂就不動）：
  1 個欄位   → useAppStore((s) => s.foo)
  多個欄位   → useAppStore(useShallow((s) => ({ foo: s.foo, bar: s.bar })))

遇到 rename（{a: b}）、rest（...r）、預設值（=）一律跳過並回報，
留給人工處理 —— 機械改寫在這幾種情況下容易改錯。
"""
import re
import sys
from pathlib import Path

PATTERN = re.compile(r'const\s*\{([^}]*)\}\s*=\s*useAppStore\(\)\s*;', re.S)
IMPORT_LINE = "import { useShallow } from 'zustand/react/shallow';\n"

changed_files, skipped, converted = [], [], 0

for path in sys.argv[1:]:
    p = Path(path)
    src = p.read_text(encoding='utf-8')
    needs_shallow = False
    local_skips = []

    def repl(m):
        global converted
        body = m.group(1)
        fields = [f.strip() for f in body.split(',') if f.strip()]
        # 保守：任何非單純識別字的形式都不碰
        if any((not re.fullmatch(r'[A-Za-z_$][\w$]*', f)) for f in fields):
            local_skips.append(body.strip()[:60])
            return m.group(0)
        if not fields:
            return m.group(0)
        converted += 1
        if len(fields) == 1:
            f = fields[0]
            return f'const {{ {f} }} = {{ {f}: useAppStore((s) => s.{f}) }};'
        nonlocal_flag['shallow'] = True
        inner = ', '.join(f'{f}: s.{f}' for f in fields)
        # 保留原本的多行排版可讀性：欄位多就折行
        if len(fields) > 6:
            joined = ',\n    '.join(f'{f}: s.{f}' for f in fields)
            return (f'const {{\n    ' + ',\n    '.join(fields) + '\n  } = useAppStore(useShallow((s) => ({\n    '
                    + joined + ',\n  })));')
        return f'const {{ {", ".join(fields)} }} = useAppStore(useShallow((s) => ({{ {inner} }})));'

    nonlocal_flag = {'shallow': False}
    out = PATTERN.sub(repl, src)
    needs_shallow = nonlocal_flag['shallow']

    if local_skips:
        skipped.append((path, local_skips))

    if out != src:
        if needs_shallow and 'zustand/react/shallow' not in out:
            lines = out.split('\n')
            # 插在最後一個 import 之後，維持 import 區塊完整
            last_import = max(i for i, l in enumerate(lines) if l.startswith('import '))
            lines.insert(last_import + 1, IMPORT_LINE.rstrip('\n'))
            out = '\n'.join(lines)
        p.write_text(out, encoding='utf-8')
        changed_files.append(path)

print(f'改寫 {converted} 處，涉及 {len(changed_files)} 個檔案')
for f in changed_files:
    print(f'  ✓ {f}')
for f, s in skipped:
    print(f'  ⚠ 跳過（需人工）：{f} → {s}')
