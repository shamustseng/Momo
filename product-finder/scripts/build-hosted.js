#!/usr/bin/env node
'use strict';

/**
 * 產出線上版的檔案到 dist/hosted/：index.html、app.js、styles.css，以及純資料的 data.json。
 *   node scripts/build-hosted.js            用目前快取的資料
 *   node scripts/build-hosted.js --refresh  先重新抓取兩邊再產出
 * 在有 proxy 的環境要加 NODE_USE_ENV_PROXY=1。
 *
 * 這支 script 由 GitHub Actions 定時執行（.github/workflows/product-finder-refresh.yml），
 * 產出的 data.json 會被推到資料分支，線上頁面開啟時直接讀那一份，不需要任何人重新發布頁面。
 *
 * --refresh 會自己判斷這次重新抓取算成功還是失敗，並把結果寫進輸出：
 *   - 至少一邊抓到資料 → 當作成功，refreshStatus 為 null
 *   - refresh() 整個丟例外，或兩邊都失敗 → 當作失敗：保留上次成功的資料（不把清單清空），
 *     refreshStatus 設為 'failed' 並附上原因，頁面上會顯示紅色橫幅提醒
 */
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const { refresh, snapshot } = require('../lib/refresh');
const { buildHosted } = require('../lib/static');

(async () => {
  let data = store.load();
  let refreshStatus = null;
  let refreshError = null;

  if (process.argv.includes('--refresh')) {
    try {
      data = await refresh('all');
      for (const entry of snapshot().log) console.log(' ·', entry.message);
      const errors = Object.values(data.sources).map((s) => s.error).filter(Boolean);
      const allFailed = errors.length > 0 && errors.length === Object.keys(data.sources).length;
      if (allFailed) {
        refreshStatus = 'failed';
        refreshError = errors.join('；');
      }
    } catch (err) {
      data = store.load();
      refreshStatus = 'failed';
      refreshError = err.message || '重新抓取時發生未知錯誤';
    }
    if (refreshStatus === 'failed') console.log(` · 重新抓取失敗：${refreshError}`);
  }

  const live = store.loadConfig().hosted || null;
  const out = path.join(__dirname, '..', 'dist', 'hosted');
  fs.mkdirSync(out, { recursive: true });
  const overrides = refreshStatus === 'failed' ? { refreshStatus, refreshError } : {};
  for (const [name, body] of Object.entries(buildHosted(data, overrides, live))) {
    fs.writeFileSync(path.join(out, name), body);
    console.log(`寫入 ${path.relative(process.cwd(), path.join(out, name))}（${(body.length / 1024).toFixed(1)} KB）`);
  }
  const total = store.allProducts(data).length;
  console.log(`共 ${total} 件商品${refreshStatus === 'failed' ? '（沿用上次成功的資料）' : ''}`);
  // 讓 GitHub Actions 能用結束碼判斷這次有沒有抓到新資料
  if (refreshStatus === 'failed') process.exitCode = 2;
})().catch((err) => { console.error(err.message); process.exit(1); });
