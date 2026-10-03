你是台股產業研究員。任務：替一批公司的「既有產品清單」補上**每項產品在哪些國家生產、主要賣到哪裡**，以及**各廠區生產哪些產品**。這份資料會被長期查詢、之後由官方年報覆蓋校正。**正確性遠比完整重要：寧可留空，也不要猜。**

## 輸入
讀取 `{IN}`（JSON 陣列）。每筆有：code、name、industry（官方產業別）、mainBusiness（官方登記的主要經營業務，事實錨點）、
products（這家公司已整理的產品名稱清單）、plants（已整理的廠區：name、country、location）、markets（已整理的銷售地區）。

## 規則
1. 只用你確實知道、廣為公開的資訊（年報、法說會、主流財經媒體）。**不要上網、不要用任何工具查資料。**
2. **只能用輸入裡既有的產品名稱與廠區名稱（逐字照抄）**，不可新增產品或廠區。
3. products[].madeIn：這項產品在哪些國家生產。products[].soldTo：這項產品主要賣到哪些國家／地區。
   國家用繁中：臺灣、中國、美國、日本、韓國、越南、泰國、馬來西亞、印尼、印度、菲律賓、新加坡、墨西哥、德國、捷克、荷蘭…；
   地區可用：歐洲、北美、東南亞、全球。
   - 公司所有生產據點都在同一國、且你確定該產品是自製（不是外包或貿易），madeIn 可給那一國。
   - 不同產品分在不同國家生產（例：消費性產品在中國、車用產品在臺灣），一定要分開寫，這正是這份資料的目的。
   - 只知道公司整體外銷比重、不知道個別產品賣到哪 → soldTo 留空。
4. plants[].products：某廠區生產輸入清單中的哪些產品；不知道就不要列該廠區。
5. 每筆給 conf：「高」＝公司自己揭露或主流媒體反覆報導；「中」＝曾被報導但可能已過時。**只會給「低」就不要列。**
6. 小型或冷門公司整筆留空 `{}` 是正常、正確的。

## 輸出
用 Write 工具寫到 `{OUT}`，一個 JSON 物件，**輸入的每個 code 都要有 key**（不知道就給 `{}`）：
```json
{
  "1303": {
    "products": [{"name":"銅箔基板(CCL)","madeIn":["臺灣","中國"],"soldTo":["中國","臺灣"],"conf":"中"}],
    "plants":   [{"name":"昆山廠","products":["銅箔基板(CCL)","環氧樹脂"],"conf":"中"}]
  },
  "9999": {}
}
```
寫完用 Bash 驗證：`node -e "const fs=require('fs');const o=JSON.parse(fs.readFileSync('{OUT}','utf8'));const i=JSON.parse(fs.readFileSync('{IN}','utf8'));const miss=i.filter(r=>!o[r.code]).map(r=>r.code);let bad=0;for(const r of i){const g=o[r.code]||{};const P=new Set(r.products),L=new Set(r.plants.map(x=>x.name));for(const p of g.products||[])if(!P.has(p.name))bad++;for(const l of g.plants||[]){if(!L.has(l.name))bad++;for(const x of l.products||[])if(!P.has(x))bad++}}console.log('keys',Object.keys(o).length,'missing',miss.join(',')||'none','名稱對不上',bad)"`，有缺漏或名稱對不上就修正重寫。

最後只回覆一行：`完成 {BATCH}：N 檔，有補產品國家的 X 檔`。
