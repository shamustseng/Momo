#!/usr/bin/env node
'use strict';

/**
 * 產出線上版（claude.ai Artifact）的三個檔案到 dist/hosted/。
 *   node scripts/build-hosted.js            用目前快取的資料
 *   node scripts/build-hosted.js --refresh  先重新抓取兩邊再產出
 * 在有 proxy 的環境要加 NODE_USE_ENV_PROXY=1。
 *
 * --refresh 會自己判斷這次重新搜尋算成功還是失敗，並把結果寫進輸出頁面：
 *   - 兩邊都抓到資料（或至少一邊成功）→ 當作成功，清空 refreshRequestedAt/refreshStatus
 *   - refresh() 整個丟例外，或兩邊都失敗 → 當作失敗，保留舊資料，
 *     refreshStatus 設為 'failed' 並附上原因，頁面上的「重新搜尋」橫幅會顯示「失敗」
 * 呼叫端（負責發布 Artifact 的 Claude session）不需要自己判斷成功或失敗，
 * 直接把這裡產出的 dist/hosted/index.html 發布出去就好。
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
      data = store.load(); // 重新抓取整個失敗，保留上次成功的資料，不要把畫面清空
      refreshStatus = 'failed';
      refreshError = err.message || '重新抓取時發生未知錯誤';
    }
    if (refreshStatus === 'failed') console.log(` · 重新搜尋失敗：${refreshError}`);
  }

  const out = path.join(__dirname, '..', 'dist', 'hosted');
  fs.mkdirSync(out, { recursive: true });
  const overrides = refreshStatus === 'failed'
    ? { refreshRequestedAt: new Date().toISOString(), refreshStatus, refreshError }
    : {};
  for (const [name, body] of Object.entries(buildHosted(data, overrides))) {
    fs.writeFileSync(path.join(out, name), body);
    console.log(`寫入 ${path.relative(process.cwd(), path.join(out, name))}（${(body.length / 1024).toFixed(1)} KB）`);
  }
  const total = store.allProducts(data).length;
  console.log(`共 ${total} 件商品${refreshStatus === 'failed' ? '（沿用上次成功的資料）' : ''}`);
})().catch((err) => { console.error(err.message); process.exit(1); });
