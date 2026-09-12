#!/usr/bin/env node
'use strict';

/**
 * 產出線上版（claude.ai Artifact）的三個檔案到 dist/hosted/。
 *   node scripts/build-hosted.js            用目前快取的資料
 *   node scripts/build-hosted.js --refresh  先重新抓取兩邊再產出
 * 在有 proxy 的環境要加 NODE_USE_ENV_PROXY=1。
 */
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const { refresh, snapshot } = require('../lib/refresh');
const { buildHosted } = require('../lib/static');

(async () => {
  let data = store.load();
  if (process.argv.includes('--refresh')) {
    data = await refresh('all');
    for (const entry of snapshot().log) console.log(' ·', entry.message);
  }
  const out = path.join(__dirname, '..', 'dist', 'hosted');
  fs.mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(buildHosted(data))) {
    fs.writeFileSync(path.join(out, name), body);
    console.log(`寫入 ${path.relative(process.cwd(), path.join(out, name))}（${(body.length / 1024).toFixed(1)} KB）`);
  }
  const total = store.allProducts(data).length;
  console.log(`共 ${total} 件商品`);
})().catch((err) => { console.error(err.message); process.exit(1); });
