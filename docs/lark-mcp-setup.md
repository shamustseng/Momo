# 讓 Claude 讀取 Lark 資料（Lark MCP 設定）

本 repo 的 `.mcp.json` 已宣告 Lark 官方 MCP 伺服器
（[`@larksuiteoapi/lark-mcp`](https://github.com/larksuite/lark-openapi-mcp)）。
Claude Code on the web 開新 session 時會自動載入 repo 內的 `.mcp.json`，
所以只要把 Lark 自建應用的憑證放進雲端環境變數，Claude 就能直接讀多維表格（Base）、
文件、訊息等資料。憑證不寫進 repo。

## 一、在 Lark 開發者後台建立自建應用（約 5 分鐘）

1. 用管理員帳號開 <https://open.larksuite.com/app>，選「建立企業自建應用」。
   名稱可填 `Claude 資料讀取`。
2. 左側「憑證與基礎資訊」頁，記下 **App ID**（`cli_` 開頭）與 **App Secret**。
3. 左側「權限管理」，搜尋並開通以下權限（只讀為主）：
   - `bitable:app:readonly`　　多維表格：讀取
   - `base:record:retrieve`　　多維表格：查詢記錄
   - `base:table:read`、`base:field:read`
   - `docx:document:readonly`　雲文件：讀取（要讀文件才需要）
   - `im:message:readonly`　　訊息：讀取（要讀群訊息才需要）
   若之後要讓 Claude 寫回資料，再加 `bitable:app`。
4. 左側「版本管理與發布」，建立版本並送出發布，等管理員核准。
   未發布的應用權限不會生效。

## 二、把應用加進要讀的那張 Base

自建應用只能讀「它被加為協作者」的文件。以庫存表為例：

1. 在 Lark 打開那張多維表格，右上角「…」→「更多」→「新增文件應用」
   （部分版本叫「添加應用」）。
2. 搜尋剛建立的 `Claude 資料讀取`，加入，權限選「可閱讀」即可。

每一張要讀的 Base 或文件都要做一次。忘了這步是最常見的「找不到資料」原因。

## 三、把憑證放進 Claude 雲端環境

1. 開 <https://claude.ai/code>，環境選擇器裡把滑鼠移到 **Momo 數據**，點設定圖示。
2. 在 **Environment variables** 欄位加入：

   ```
   LARK_APP_ID=cli_xxxxxxxxxxxxxxxx
   LARK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
   ```

   可選：
   - `LARK_DOMAIN`：預設 `https://open.larksuite.com`（國際版 Lark）。
     若你們用的是中國版飛書，改成 `https://open.feishu.cn`。
   - `LARK_TOOLS`：預設 `preset.default,preset.base.batch`。
     只想開放讀 Base 可改成 `preset.base.default`。
3. **Network access** 維持 Custom，Allowed domains 需包含 `*.larksuite.com`
   （已設定），並勾選「Also include default list of common package managers」，
   因為第一次啟動要從 npm 下載 `@larksuiteoapi/lark-mcp`。
4. Save changes。環境變數只在 session 啟動時讀一次，**改完要開新的 session**。

## 四、驗證

在新 session 直接問 Claude，例如：

> 列出這張 Base 有哪些資料表：https://xxx.sg.larksuite.com/base/XXXXXXXX

Claude 會呼叫 `bitable_v1_appTable_list`、`bitable_v1_appTableRecord_search`
等工具回答。若回「權限不足」或「找不到」，依序檢查：
應用是否已發布、權限是否開通、應用是否已加進該文件、環境變數有無打錯。

## 注意

- App Secret 等同密碼。放在環境變數即可，不要貼進對話或 commit。
  環境變數對所有使用該環境的人可見，若要更嚴格，改用環境設定裡的 API credentials。
- 「查詢分享連結」（`/share/base/query/...`）是給人用瀏覽器看的，
  MCP 走的是 Open API，需要的是 Base 本身的連結或 app_token。
