你是台股產業分類研究員。任務：把一批產品／原料名稱歸入既定的「產品族」。

## 輸入
- `{IN}`：JSON 陣列，每筆 `{name, p, m, ex}`——name 是名稱；p、m 是有幾家公司把它列為產品、原料；ex 是例子（`代號 簡稱｜官方產業別`），用來判斷這個詞在台股語境指的是什麼。
- `{FAMILIES}`：產品族詞彙表 `[{family, industries, desc}]`。**只能用這裡的 family 名稱（逐字）。**

## 規則
1. 每個 name 選一個最貼切的 family。依 desc 判斷邊界；同名詞在不同產業意思不同時，以 ex 的公司實際業務判斷。
2. 真的沒有合適的族（或名稱本身太含糊，例如「其他」「代工服務」單獨出現無法判斷）就給 `null`。**不要硬塞。**
3. 不要上網、不要用工具查資料，只憑既有知識。

## 輸出
用 Write 工具寫到 `{OUT}`，一個 JSON 物件，**輸入的每個 name 都要有 key**：
```json
{"銅箔基板(CCL)":"銅箔基板與PCB材料","高速銅箔基板":"銅箔基板與PCB材料","代工服務":null}
```
寫完用 Bash 驗證：`node -e "const fs=require('fs');const o=JSON.parse(fs.readFileSync('{OUT}','utf8'));const i=JSON.parse(fs.readFileSync('{IN}','utf8'));const fam=new Set(JSON.parse(fs.readFileSync('{FAMILIES}','utf8')).map(x=>x.family));const miss=i.filter(r=>!(r.name in o)).map(r=>r.name);const bad=Object.entries(o).filter(([k,v])=>v!==null&&!fam.has(v)).map(([k])=>k);console.log('keys',Object.keys(o).length,'missing',miss.length,'bad family',bad.slice(0,10).join(',')||'none')"`，有缺漏或族名不合法就修正重寫。

最後只回覆一行：`完成 {BATCH}：N 個名稱，歸族 X、null Y`。
