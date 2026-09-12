#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const store = require('./lib/store');
const { refresh, snapshot } = require('./lib/refresh');
const { toCsv, toMarkdown } = require('./lib/export');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function argValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index > -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
}
const hasFlag = (flag) => process.argv.includes(flag);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('找不到檔案');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

function sendDownload(res, filename, asciiName, body, contentType) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    // HTTP 標頭不能直接放中文，所以 filename= 用純英數的備援名稱，
    // 中文檔名放在支援 UTF-8 的 filename*=
    'Content-Disposition':
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new Error('請求內容過大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 依來源與關鍵字挑出商品；搜尋會同時比對名稱與商品編號。 */
function selectProducts(data, { source = 'all', q = '' } = {}) {
  let products = store.allProducts(data);
  if (source && source !== 'all') products = products.filter((p) => p.source === source);
  const needle = q.trim().toLowerCase();
  if (needle) {
    const terms = needle.split(/\s+/);
    products = products.filter((p) => {
      const haystack = `${p.name} ${p.sku || ''} ${(p.keywords || []).join(' ')}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }
  return products;
}

function updatedMap(data) {
  const out = {};
  for (const [key, source] of Object.entries(data.sources || {})) out[key] = source.updatedAt;
  return out;
}

/** 台北時間的 YYYYMMDD-HHMM，用在匯出檔名上。 */
function stamp() {
  const local = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
  return `${local.slice(0, 10).replace(/-/g, '')}-${local.slice(11, 16).replace(':', '')}`;
}

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/products' && req.method === 'GET') {
    const data = store.load();
    const config = store.loadConfig();
    return sendJson(res, 200, {
      sources: data.sources || {},
      note: data.note || null,
      keywords: (config.sources.momo && config.sources.momo.keywords) || [],
      job: snapshot(),
    });
  }

  if (route === '/api/job' && req.method === 'GET') {
    return sendJson(res, 200, snapshot());
  }

  if (route === '/api/refresh' && req.method === 'POST') {
    const which = url.searchParams.get('source') || 'all';
    if (snapshot().running) return sendJson(res, 409, { error: '已經有一個抓取工作在進行中。' });
    // 抓取可能要跑幾十秒，先回覆前端，讓它用 /api/job 追進度
    refresh(which).catch((err) => console.error('[refresh]', err.message));
    await new Promise((r) => setTimeout(r, 50));
    return sendJson(res, 202, snapshot());
  }

  if (route === '/api/keywords' && req.method === 'PUT') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const keywords = (Array.isArray(body.keywords) ? body.keywords : [])
      .map((k) => String(k).trim())
      .filter(Boolean)
      .slice(0, 20);
    if (!keywords.length) return sendJson(res, 400, { error: '至少要留一個關鍵字。' });
    const config = store.loadConfig();
    config.sources.momo.keywords = keywords;
    store.saveConfig(config);
    return sendJson(res, 200, { keywords });
  }

  if (route === '/api/export.csv' || route === '/api/export.md') {
    const data = store.load();
    const products = selectProducts(data, {
      source: url.searchParams.get('source') || 'all',
      q: url.searchParams.get('q') || '',
    });
    const at = stamp();
    if (route === '/api/export.csv') {
      return sendDownload(res, `產品清單_${at}.csv`, `alpha-products_${at}.csv`,
        toCsv(products), 'text/csv; charset=utf-8');
    }
    return sendDownload(res, `產品清單_${at}.md`, `alpha-products_${at}.md`,
      toMarkdown(products, updatedMap(data)), 'text/markdown; charset=utf-8');
  }

  return sendJson(res, 404, { error: '沒有這個 API' });
}

function createServer() {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const filePath = path.join(PUBLIC_DIR, rel);
    // 擋掉 ../ 之類想跳出 public/ 的路徑
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end();
      return;
    }
    sendFile(res, filePath);
  });
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(`阿爾法餐飲 產品查詢器

  node server.js                    啟動網頁介面（預設 http://127.0.0.1:5173）
  node server.js --port 8080        指定連接埠
  node server.js --host 0.0.0.0     開放同網段的同事連線
  node server.js --refresh-only     只重新抓取，不啟動網頁
  node server.js --refresh-only --export 清單.csv
  node server.js --source momo      搭配 --refresh-only，只抓單一來源
`);
    return;
  }

  const config = store.loadConfig();

  if (hasFlag('--refresh-only')) {
    const which = argValue('--source', 'all');
    console.log(`開始抓取（${which}）…`);
    const data = await refresh(which);
    for (const entry of snapshot().log) console.log(' ·', entry.message);
    const exportPath = argValue('--export');
    if (exportPath) {
      const products = store.allProducts(data);
      const body = exportPath.endsWith('.md')
        ? toMarkdown(products, updatedMap(data))
        : toCsv(products);
      fs.writeFileSync(exportPath, body);
      console.log(`已輸出 ${products.length} 筆到 ${exportPath}`);
    }
    return;
  }

  const port = Number(argValue('--port', process.env.PORT || config.port || 5173));
  const host = argValue('--host', '127.0.0.1');
  createServer().listen(port, host, () => {
    const shown = host === '0.0.0.0' ? '你的電腦 IP' : host;
    console.log(`產品查詢器已啟動：http://${shown}:${port}`);
    console.log('按 Ctrl+C 結束。');
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('啟動失敗：', err.message);
    process.exit(1);
  });
}

module.exports = { createServer, selectProducts };
