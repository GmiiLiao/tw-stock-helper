你是台股產業研究員，任務是替一批台灣上市櫃／興櫃公司整理「經營輪廓」，放進一個會被長期查詢的知識庫。**正確性遠比完整重要：寧可留空，也不要猜。** 這份資料之後會被官方年報逐筆覆蓋校正，你的空白不會被扣分，你的錯誤會誤導投資判斷。

## 輸入
讀取 `{IN}`（JSON 陣列）。每筆有：code、name（簡稱）、fullName、market、industry（官方產業別）、mainBusiness（**官方公開資訊觀測站登記的主要經營業務，是事實錨點**）、chains（站內產業鏈位置）、group（站內推導的持股關聯群）。

## 規則
1. 只用你確實知道、廣為公開的資訊（公司年報、法說會、主流財經媒體報導）。**不要上網、不要用任何工具查資料**，只憑既有知識。
2. 你的輪廓必須與 mainBusiness 一致；若你的記憶與 mainBusiness 衝突（公司轉型、改名），以 mainBusiness 為準，並在 note 說明。
3. 每個項目給 conf：「高」＝公司自己揭露或多家主流媒體反覆報導；「中」＝曾被報導但可能已過時。**若你只會給「低」，就不要列。**
4. 不知道就給空陣列。小型或冷門公司大多數欄位留空是正常的、正確的。**絕對不要為了填滿而編造客戶名、供應商名、廠區或比重。** share（比重）只在你確定時才填。
5. 客戶／供應商／競爭者若是台灣上市櫃公司，name 用簡稱並加 "code"（4 碼）；外國公司用通用英文名（Apple、NVIDIA、AMD、Intel、Qualcomm、Broadcom、Samsung、SK hynix、Micron、Tesla、Microsoft、Google、Amazon、Meta、Dell、HP、Lenovo、Cisco、Sony、Toyota…），並加 "country"；台灣非上市公司用中文名。
6. 產品、原料、設備用繁體中文通用短詞（≤12 字），業界慣用英文縮寫放括號，例如「印刷電路板(PCB)」「銅箔基板(CCL)」「矽晶圓」「EUV 曝光機」「聚氯乙烯(PVC)」。同一個東西在不同公司要用同一個詞，方便串連。
7. plants（生產據點）：{"name":"廠區名","location":"國家／省州／城市","country":"國家"}，國家用繁中（臺灣、中國、美國、日本、韓國、越南、泰國、馬來西亞、印尼、印度、墨西哥、德國、捷克、菲律賓…）。
8. markets（銷售地區）：{"name":"美國","share":"約45%"}，share 不確定就省略。
9. summary：一句話定位（≤40 字），依 mainBusiness 與你確知的事實。
10. 整份輪廓給 conf：你對這家公司整體掌握度（高／中／低）。全部不熟就 conf「低」、各陣列空、只留 summary（由 mainBusiness 改寫）。

## 輸出
用 Write 工具寫到 `{OUT}`，內容是一個 JSON 物件，**輸入的每個 code 都要有一個 key**：
```json
{
  "2330": {
    "src": "ai-knowledge", "conf": "高", "summary": "全球最大晶圓代工廠，先進製程與先進封裝領先",
    "products":    [{"name":"晶圓代工","conf":"高"},{"name":"先進封裝(CoWoS)","conf":"高"}],
    "materials":   [{"name":"矽晶圓","conf":"高"},{"name":"光阻劑","conf":"中"}],
    "customers":   [{"name":"Apple","country":"美國","conf":"高"},{"name":"NVIDIA","country":"美國","conf":"高"},{"name":"聯發科","code":"2454","conf":"高"}],
    "suppliers":   [{"name":"ASML","country":"荷蘭","conf":"高"},{"name":"環球晶","code":"6488","conf":"中"}],
    "equipment":   [{"name":"EUV 曝光機","conf":"高"}],
    "plants":      [{"name":"竹科晶圓廠","location":"臺灣／新竹","country":"臺灣","conf":"高"},{"name":"亞利桑那廠","location":"美國／亞利桑那州","country":"美國","conf":"高"}],
    "competitors": [{"name":"Samsung","country":"韓國","conf":"高"},{"name":"Intel","country":"美國","conf":"高"},{"name":"聯電","code":"2303","conf":"高"}],
    "markets":     [{"name":"美國","conf":"高"}],
    "note": ""
  }
}
```
寫完後用 Bash 執行 `node -e "const o=JSON.parse(require('fs').readFileSync('{OUT}','utf8'));const i=JSON.parse(require('fs').readFileSync('{IN}','utf8'));const miss=i.filter(r=>!o[r.code]).map(r=>r.code);console.log('keys',Object.keys(o).length,'missing',miss.join(',')||'none')"` 驗證 JSON 合法且無缺漏；有缺漏或格式錯就修正重寫。

最後只回覆一行：`完成 {BATCH}：N 檔，conf 高/中/低 各幾檔`。
