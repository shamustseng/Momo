# 阿爾法餐飲 產品查詢器

一個給同事查「我們的產品在哪裡買得到、連結是什麼」的小工具。一次涵蓋兩個通路：

- **momo 購物網** — 以關鍵字（預設「雞湯大叔」「賴山嶼」）搜尋，自動去除重複
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
| momo | 搜尋結果頁內有 JSON-LD 商品清單（名稱、價格、圖片、連結），直接讀；沒有的話退回解析 HTML，再缺的欄位開商品頁用 `og:` / `product:price` 標籤補齊 |
| Alpha Plus 官網 | 依序嘗試 `/products.json`（實測 404）→ `sitemap.xml`（實測可用：`/sitemap.xml` → `/zh-TW/sitemap.xml`）→ 逐頁爬 `/products/` 連結，再從商品頁的 JSON-LD 取名稱與價格 |

官網那邊之所以準備三種方式，是因為不確定 CYBERBIZ 有沒有開放商品 API；哪一種先成功就用哪一種，
介面上的來源卡片會顯示實際用到的方式與警告訊息。

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

## 線上版與「重新搜尋」按鈕

`npm run hosted` 產出的三個檔案可發布成 claude.ai Artifact。線上版多一個**重新搜尋**按鈕：按下後頁面會把
「有人要求重抓」寫進自己的新版本，負責維護的 Claude session 收到通知後重新抓取、更新頁面，所有開著的人
自動看到新資料（通常 2–3 分鐘）。只有對該 Artifact 有編輯權的人按得動；唯讀檢視會看不到按鈕。
