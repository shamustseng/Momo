#!/usr/bin/env node
'use strict';

/**
 * 產出兩份網頁：
 *   dist/hosted/  GitHub Pages 網站版（index.html、app.js、styles.css、data.json、.nojekyll）——正式使用的版本
 *   dist/claude/  claude.ai 唯讀副本（index.html、app.js、styles.css）——沙箱裡不能連 GitHub，只顯示資料
 *
 *   node scripts/build-hosted.js            用目前快取的資料
 *   node scripts/build-hosted.js --refresh  先重新抓取兩邊再產出
 * 在有 proxy 的環境要加 NODE_USE_ENV_PROXY=1。
 *
 * 這支 script 由 GitHub Actions 執行（.github/workflows/product-finder-refresh.yml，網站上按「重新搜尋」時），
 * dist/hosted/ 會被推到資料分支，GitHub Pages 從那個分支提供網站。
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
const { buildHosted, buildSite } = require('../lib/static');

function writeAll(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
    console.log(`寫入 ${path.relative(process.cwd(), path.join(dir, name))}（${(body.length / 1024).toFixed(1)} KB）`);
  }
}

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
  const overrides = refreshStatus === 'failed' ? { refreshStatus, refreshError } : {};
  const dist = path.join(__dirname, '..', 'dist');
  writeAll(path.join(dist, 'hosted'), buildSite(data, overrides, live));
  const claude = buildHosted(data, overrides, live);
  delete claude['data.json'];
  writeAll(path.join(dist, 'claude'), claude);

  const total = store.allProducts(data).length;
  console.log(`共 ${total} 件商品${refreshStatus === 'failed' ? '（沿用上次成功的資料）' : ''}`);
  // 讓 GitHub Actions 能用結束碼判斷這次有沒有抓到新資料
  if (refreshStatus === 'failed') process.exitCode = 2;
})().catch((err) => { console.error(err.message); process.exit(1); });
