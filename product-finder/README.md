# 阿爾法餐飲 產品查詢器

一個給同事查「我們的產品在哪裡買得到、連結是什麼」的小工具。一次涵蓋兩個通路：

- **momo 購物網** — 以五個品牌關鍵字（雞湯大叔、賴山嶼、雞湯桑、麵屋一燈、撈王）搜尋，自動去除重複
- **Alpha Plus 官網** — https://alphaplus.cyberbiz.co 上架中的商品

可以在兩邊之間切換、搜尋、排序，**一鍵重新抓取**兩邊的最新資料，**一鍵輸出**全部的產品與連結
（CSV / Markdown / 直接複製）。

## 怎麼啟動

1. 先安裝 [Node.js](https://nodejs.org/zh-tw)（選 LTS 版，一路按下一步即可；只需裝一次）。
2. 開啟終端機／命令提示字元，切到這個資料夾，執行：

   ```
   node server.js
   ```

3. 瀏覽器打開 **http://127.0.0.1:5173** 就是介面了。結束請按 `Ctrl + C`。

不需要 `npm install`，這個工具沒有任何外部套件。

### 其他啟動方式

| 指令 | 用途 |
| --- | --- |
| `node server.js --port 8080` | 換一個連接埠（5173 被佔用時） |
| `node server.js --host 0.0.0.0` | 讓同網段的同事用你的電腦 IP 連進來 |
| `node server.js --refresh-only` | 只重新抓取、不開介面 |
| `node server.js --refresh-only --export 清單.csv` | 抓完直接輸出成檔案（可排程） |
| `node server.js --source momo --refresh-only` | 只重抓單一來源 |
| `node server.js --export 產品清單.html` | 產出不需伺服器的單檔網頁（可直接雙擊開、可搜尋） |
| `npm run hosted` | 重新抓取後產出線上版（claude.ai）的檔案到 `dist/hosted/` |
| `npm test` | 跑測試 |

在公司以外、需要走 proxy 的環境（例如 Claude Code 雲端 session）執行時，Node 內建的 fetch 不會自動讀
`HTTPS_PROXY`，要加 `NODE_USE_ENV_PROXY=1`。

## 介面怎麼用

- **上方分頁**：切換「全部 / momo 購物網 / Alpha Plus 官網」。
- **重新抓取**：重跑抓取。停在「全部」分頁時兩邊都抓；停在單一來源時只抓那一邊。
  抓取需要數十秒，過程會顯示進度明細。
- **搜尋框**：比對商品名稱、momo 商品編號、以及是哪個關鍵字搜到的。空白可分隔多個字，
  例如「辣醬 3入」代表兩個條件都要符合。按 `/` 可直接跳到搜尋框。
- **一鍵輸出**：下載 CSV（Excel 可直接開，已處理中文編碼）、下載 Markdown、
  或直接把「名稱＋價格＋連結」複製到剪貼簿。輸出的範圍就是畫面上目前篩選的結果——
  想輸出全部就先切到「全部」並清空搜尋框。
- **momo 搜尋關鍵字設定**：之後要加新品牌（例如「雞湯桑」「麵屋一燈」），在這裡加一行、
  儲存，下次重新抓取就會一起搜。

## 資料從哪裡來

| 來源 | 做法 |
| --- | --- |
| momo | 搜尋結果頁內有 JSON-LD 商品清單（名稱、圖片、連結），直接讀；沒有的話退回解析 HTML。價格一律再開商品頁取「促銷價」欄位——搜尋頁與 `product:price` 標籤給的是頭條價，有限時活動時會變成「限時折後價」，不是我們要的 |
| Alpha Plus 官網 | `sitemap.xml` 與店面頁面（首頁、`/collections/all` 與各分類頁含分頁）**兩邊都抓**，合併去重後再開商品頁取名稱與價格。實測 sitemap 會過期——9/19 新上架的禮品卡、娃娃、贈品頁好幾天都不在裡面，只信 sitemap 會漏；第一次沒讀到的商品頁會隔一下再補抓一次（官網沒有 `/products.json`，不再嘗試）。滿額贈品頁掛的是 99999 佈告價，會標成「贈品」不顯示價格 |

介面上的來源卡片會顯示實際用到的方式（`sitemap+crawl` / `crawl` / `sitemap`）與警告訊息。

抓取結果存在 `data/cache.json`（不進版控）。第一次打開時還沒有快取，會先顯示
`data/seed.json` 裡 2026-09-12 實際抓取的資料（momo 24 筆、官網 11 筆），按一次「重新抓取」就會換成即時資料。

momo 的關鍵字搜尋是模糊比對（「雞湯桑」會撈到別家的「桑拿雞蒸鍋」），所以 `config.json` 的
`mustMatch` 列了集團品牌字樣，名稱裡沒有這些字的商品會被略過。

## 注意事項

- 兩個網站的 HTML 改版時，抓取可能會少抓或抓不到。介面上的來源卡片會顯示「0 件商品」或紅色錯誤，
  看到就代表需要調整 `lib/momo.js` / `lib/cyberbiz.js` 的解析規則。
- 抓取失敗時**會保留上一次的資料**，不會把清單清空。
- 抓取有限制併發數與間隔（預設 3 個同時、每次間隔 350 毫秒），請不要調得太猛。
  相關設定在 `config.json` 的 `network` 區塊。
- 價格與上架狀態以各站台當下顯示為準，本工具只是方便查找與彙整。

## 檔案

```
server.js          網頁伺服器 + API + 命令列模式
config.json        來源、關鍵字、連線參數設定
lib/momo.js        momo 抓取與解析
lib/cyberbiz.js    Alpha Plus 官網抓取與解析
lib/html.js        meta / JSON-LD / 價格 解析工具
lib/http.js        連線、重試、併發控制
lib/refresh.js     抓取工作排程與進度
lib/export.js      CSV / Markdown 輸出
lib/store.js       快取與設定讀寫
public/            網頁介面
data/seed.json     初始清單（第一次使用時的預設資料）
test/              測試
```

## 線上版：按「重新搜尋」才重抓，不靠 Claude

`npm run hosted` 產出 `dist/hosted/` 四個檔案（index.html、app.js、styles.css、data.json），前三個發布成 claude.ai Artifact。

重抓由 GitHub Actions（`.github/workflows/product-finder-refresh.yml`）執行，沒有定時排程，只在有人按 Run workflow 時跑：

1. 線上頁的**重新搜尋**按鈕會在新分頁開這個 workflow 的 GitHub 頁面；有 repo 權限的人按「Run workflow」→ 綠色「Run workflow」。
   （GitHub 沒有不登入就能觸發的方式，所以這一下一定要在 GitHub 上按。）
2. workflow 跑 `node scripts/build-hosted.js --refresh`，把 momo 與官網重抓一遍（約 1 分鐘），
   把產出的 `data.json`（加上 `cache.json`）強制推到 `product-finder-data` 分支——這個分支永遠只有一個 commit，不會弄髒主分支歷史。
3. 線上頁同時每 15 秒讀一次 `https://raw.githubusercontent.com/shamustseng/Momo/product-finder-data/data.json`
   （公開 repo 有 CORS 標頭，CDN 快取 5 分鐘，頁面會加時間戳避開），拿到新的就自動換上，所以**頁面本身不用重新發布**。
   開頁面時也會先讀一次，永遠顯示最近一次抓取的結果；讀不到時退回 index.html 內嵌的那一份（發布當時的資料）。

失敗時怎麼提醒：
- 等了 10 分鐘還沒有新資料（沒按 Run workflow、或抓取掛了）→ 頁面顯示紅色橫幅，停止等待。
- 兩邊都抓不到 → `data.json` 沿用上一次成功的資料、`refreshStatus: 'failed'`，頁面顯示紅色橫幅與原因；workflow 本身也會標成失敗，GitHub 會寄通知。

**注意**：手動 Run workflow 只認**預設分支**上的 workflow 檔，這個檔案改了要合併進預設分支才生效。相關網址在 `config.json` 的 `hosted` 區塊。
