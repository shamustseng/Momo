'use strict';

const fs = require('fs');
const path = require('path');
const { LABEL } = require('./export');

const STYLES = path.join(__dirname, '..', 'public', 'styles.css');

/**
 * 把商品資料打包成不需要伺服器的網頁。兩種產物共用同一份版面與程式：
 *  - buildStaticHtml(data)：單一 HTML 檔，樣式／程式／資料全內嵌，雙擊即開。
 *  - buildHosted(data)：發布到 claude.ai 用的三個檔案（index.html、app.js、styles.css）。
 *    線上版多一個「重新搜尋」按鈕：按下去頁面會把「有人要求重抓」寫回自己的新版本，
 *    負責維護的 Claude session 收到通知後重新抓取並更新頁面。
 */

function preparePayload(data) {
  const sources = {};
  for (const key of ['momo', 'alphaplus']) {
    const s = (data.sources || {})[key];
    if (!s) continue;
    sources[key] = {
      label: s.label || LABEL[key] || key,
      updatedAt: s.updatedAt || null,
      seeded: Boolean(s.seeded),
      // 單檔版沒有「重新抓取」按鈕，把提示改成單檔情境的說法
      warnings: (s.warnings || []).map((w) => w.replace('請按「重新抓取」', '需在 product-finder 重新抓取後重新輸出')),
      error: s.error || null,
      products: (s.products || []).map((p) => ({
        source: key, sku: p.sku || '', name: p.name, price: p.price ?? null,
        url: p.url, status: p.status || '', keywords: p.keywords || [],
      })),
    };
  }
  return { generatedAt: new Date().toISOString(), refreshRequestedAt: null, sources };
}

const EXTRA_CSS = `
.static-note{ font-size:12.5px; color:var(--ink-muted); margin:0; }
.refresh-banner{ margin-top:14px; padding:12px 16px; display:flex; align-items:center; gap:10px; font-size:13.5px; }
.refresh-banner .spinner{ display:inline-block; }
.refresh-banner.stale .spinner{ display:none; }
`;

/** <body> 內的版面。兩種產物與線上版的自我更新都從這裡產生，只有這一份。 */
const MARKUP = `
<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <span class="eyebrow">Alpha Restaurant Group</span>
      <h1>產品清單</h1>
    </div>
    <nav class="tabs" id="tabs" role="tablist">
      <button class="tab is-active" data-source="all" role="tab">全部</button>
      <button class="tab" data-source="momo" role="tab">momo 購物網</button>
      <button class="tab" data-source="alphaplus" role="tab">Alpha Plus 官網</button>
    </nav>
    <div class="actions">
      <button class="btn" id="refresh-btn" hidden>重新搜尋</button>
      <div class="menu">
        <button class="btn btn-primary" id="export-btn" aria-haspopup="true" aria-expanded="false">一鍵輸出</button>
        <div class="menu-panel" id="export-menu" hidden>
          <button data-export="clip">複製全部名稱＋價格＋連結</button>
          <button data-export="links">只複製連結</button>
          <button data-export="csv" id="csv-btn">下載 CSV（Excel）</button>
        </div>
      </div>
    </div>
  </div>
</header>

<main class="wrap">
  <section class="panel toolbar">
    <label class="field search">
      <span class="label">搜尋商品</span>
      <input type="search" id="q" placeholder="輸入商品名稱、關鍵字或商品編號，例如：辣醬、賴山嶼、15250521" autocomplete="off">
    </label>
    <label class="field">
      <span class="label">排序</span>
      <select id="sort">
        <option value="default">預設（來源順序）</option>
        <option value="price-asc">價格：低 → 高</option>
        <option value="price-desc">價格：高 → 低</option>
        <option value="name">名稱</option>
      </select>
    </label>
    <label class="check"><input type="checkbox" id="only-listed"> 只看上架中</label>
    <p class="count" id="count">—</p>
  </section>

  <section class="panel refresh-banner" id="refresh-banner" hidden>
    <span class="spinner" aria-hidden="true"></span>
    <span id="refresh-text"></span>
  </section>

  <section class="status-row" id="status-row"></section>
  <section id="results" class="results" aria-live="polite"></section>

  <footer class="foot">
    <p id="generated"></p>
    <p>資料由程式抓取 momo 搜尋結果與 Alpha Plus 官網商品頁；價格與上架狀態以各站台當下顯示為準。</p>
  </footer>
</main>
<div class="toast" id="toast" hidden></div>
`;

/** 頁面程式。\`MARKUP_JSON\` 與 \`HOSTED\` 兩個佔位符在打包時填入。 */
const APP_JS = String.raw`'use strict';
const HOSTED = __HOSTED__;
const MARKUP = __MARKUP_JSON__;
const DATA = JSON.parse(document.getElementById('data').textContent);
const LABELS = { momo: 'momo 購物網', alphaplus: 'Alpha Plus 官網' };
const ORDER = ['momo', 'alphaplus'];
const state = { source: 'all', q: '', sort: 'default', onlyListed: false };
const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}
const fmtPrice = (p) => (p === null || p === undefined) ? null : '$' + Number(p).toLocaleString('zh-TW');
function fmtTime(iso, withYear) {
  if (!iso) return '尚未抓取';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '尚未抓取';
  const opts = { hour12: false, timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  if (withYear) opts.year = 'numeric';
  return d.toLocaleString('zh-TW', opts);
}

function visible() {
  let list = [];
  for (const key of ORDER) {
    if (state.source !== 'all' && state.source !== key) continue;
    const s = DATA.sources[key];
    if (s) list.push(...s.products);
  }
  const terms = state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) list = list.filter((p) => {
    const hay = (p.name + ' ' + p.sku + ' ' + p.keywords.join(' ')).toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  if (state.onlyListed) list = list.filter((p) => !p.status);
  const byPrice = (a, b) => ((a.price ?? Infinity) - (b.price ?? Infinity)) || a.name.localeCompare(b.name, 'zh-TW');
  if (state.sort === 'price-asc') list.sort(byPrice);
  else if (state.sort === 'price-desc') list.sort((a, b) => byPrice(b, a));
  else if (state.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh-TW'));
  return list;
}

function card(p) {
  const c = el('div', 'card');
  const a = el('a', 'name', p.name); a.href = p.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  c.append(a);
  const price = fmtPrice(p.price);
  c.append(el('span', price ? 'price' : 'price none', price || '價格未取得'));
  const actions = el('div', 'row-actions');
  const copy = el('button', 'btn btn-quiet', '複製連結');
  copy.addEventListener('click', () => copyText(p.url, '已複製連結'));
  actions.append(copy); c.append(actions);
  const sub = el('div', 'sub');
  sub.append(el('span', 'pill ' + p.source, LABELS[p.source]));
  if (p.sku) sub.append(el('span', 'pill', '編號 ' + p.sku));
  if (p.status) sub.append(el('span', 'pill warn', p.status));
  for (const k of p.keywords) sub.append(el('span', 'pill', k));
  c.append(sub);
  return c;
}

function render() {
  const row = $('status-row'); row.replaceChildren();
  for (const key of ORDER) {
    const s = DATA.sources[key]; if (!s) continue;
    const box = el('div', 'status-card ' + key);
    const h = el('h3');
    h.append(el('span', 'dot' + (s.error ? ' bad' : (s.seeded || !s.updatedAt) ? ' stale' : '')), document.createTextNode(s.label));
    box.append(h, el('p', 'meta', s.products.length + ' 件商品　·　資料時間：' + fmtTime(s.updatedAt, true)));
    if (s.error) box.append(el('p', 'msg bad', '抓取失敗：' + s.error));
    for (const w of s.warnings) box.append(el('p', 'msg', w));
    row.append(box);
  }

  const list = visible();
  const results = $('results'); results.replaceChildren();
  if (!list.length) {
    const empty = el('div', 'panel empty');
    empty.append(el('p', null, state.q ? '找不到符合「' + state.q + '」的商品。' : '這個來源目前沒有商品資料。'));
    results.append(empty);
  } else if (state.sort === 'default' && state.source === 'all') {
    for (const key of ORDER) {
      const group = list.filter((p) => p.source === key); if (!group.length) continue;
      const head = el('div', 'group-head');
      head.append(el('h2', null, LABELS[key]), el('span', 'n', group.length + ' 件'));
      results.append(head); group.forEach((p) => results.append(card(p)));
    }
  } else list.forEach((p) => results.append(card(p)));

  const total = ORDER.reduce((n, k) => n + ((DATA.sources[k] || { products: [] }).products.length), 0);
  $('count').textContent = '顯示 ' + list.length + ' / 共 ' + total + ' 件';
  renderRefreshState();
}

/* ---------- 重新搜尋（只有線上版會亮起來） ---------- */

function renderRefreshState() {
  const banner = $('refresh-banner');
  const at = DATA.refreshRequestedAt;
  if (!at) { banner.hidden = true; return; }
  const ageMin = (Date.now() - new Date(at).getTime()) / 60000;
  banner.hidden = false;
  banner.classList.toggle('stale', ageMin > 15);
  $('refresh-text').textContent = ageMin > 15
    ? '上次於 ' + fmtTime(at) + ' 送出的重新搜尋還沒完成，可以再按一次「重新搜尋」。'
    : '已於 ' + fmtTime(at) + ' 送出重新搜尋，正在抓取 momo 與官網，完成後本頁會自動更新（通常 2–3 分鐘）。';
  const btn = $('refresh-btn');
  if (!btn.hidden) btn.disabled = ageMin <= 15;
}

function renderIndex(payload) {
  const json = JSON.stringify(payload).replace(/<\//g, '<\\/');
  return '<!doctype html>\n<html lang="zh-TW">\n<head>\n<meta charset="utf-8">\n<title>阿爾法產品清單</title>\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="color-scheme" content="light dark">\n' +
    '<link rel="stylesheet" href="styles.css">\n</head>\n<body>' + MARKUP +
    '<script id="data" type="application/json">' + json + '</' + 'script>\n<script src="app.js"></' + 'script>\n</body>\n</html>\n';
}

async function setupRefresh() {
  if (!HOSTED || !window.claude || typeof window.claude.use !== 'function') return;
  const artifact = await window.claude.use('artifact');
  if (!artifact) return;
  const btn = $('refresh-btn');
  btn.hidden = false;
  renderRefreshState();
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '送出中…';
    try {
      await artifact.publish(renderIndex({ ...DATA, refreshRequestedAt: new Date().toISOString() }));
      // 成功後頁面會自動重新載入到新版本，不需要再做什麼
    } catch (err) {
      const code = err && err.code;
      if (code === 'conflict') return; // 別人剛更新了，頁面正在重新載入
      if (code === 'not_writer' || code === 'not_granted' || code === 'not_declared') {
        btn.hidden = true;
        toast('這個檢視是唯讀的，無法觸發重新搜尋。');
        return;
      }
      btn.disabled = false;
      btn.textContent = '重新搜尋';
      toast(code === 'rate_limited' ? '送出太頻繁，請稍後再試。' : '送出失敗，請稍後再試。');
    }
  });
}

/* ---------- 輸出 ---------- */

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    toast(ok ? msg : '複製失敗');
  }
}
function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function buildCsv(list) {
  const rows = [['來源', '商品名稱', '售價(TWD)', '商品連結', '商品編號', '狀態', '對應關鍵字']];
  for (const p of list) rows.push([LABELS[p.source], p.name, p.price ?? '', p.url, p.sku, p.status || '上架中', p.keywords.join(' / ')]);
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
function exportAction(kind) {
  const list = visible();
  if (!list.length) return toast('目前沒有可輸出的商品');
  if (kind === 'links') return copyText(list.map((p) => p.url).join('\n'), '已複製 ' + list.length + ' 個連結');
  if (kind === 'clip') return copyText(list.map((p) => p.name + '｜' + (fmtPrice(p.price) || '價格未取得') + (p.status ? '｜' + p.status : '') + '｜' + p.url).join('\n'), '已複製 ' + list.length + ' 筆');
  const csv = buildCsv(list);
  if (HOSTED) return copyText(csv, '已複製 CSV 內容，貼進 Excel 即可'); // 線上檢視器不允許頁面自行下載檔案
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = '產品清單_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.csv';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('已開始下載 CSV');
}

/* ---------- 事件 ---------- */

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab'); if (!tab) return;
  state.source = tab.dataset.source;
  for (const n of $('tabs').children) n.classList.toggle('is-active', n === tab);
  render();
});
let qTimer;
$('q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value; render(); }, 120); });
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
$('only-listed').addEventListener('change', (e) => { state.onlyListed = e.target.checked; render(); });
$('export-btn').addEventListener('click', () => { const m = $('export-menu'); m.hidden = !m.hidden; $('export-btn').setAttribute('aria-expanded', String(!m.hidden)); });
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) { $('export-menu').hidden = true; $('export-btn').setAttribute('aria-expanded', 'false'); } });
$('export-menu').addEventListener('click', (e) => { const k = e.target.dataset.export; if (!k) return; $('export-menu').hidden = true; exportAction(k); });
document.addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement !== $('q')) { e.preventDefault(); $('q').focus(); } });

if (HOSTED) $('csv-btn').textContent = '複製 CSV 內容（貼進 Excel）';
$('generated').textContent = '資料產出時間：' + fmtTime(DATA.generatedAt, true);
render();
setupRefresh();
`;

function appJs(hosted) {
  return APP_JS
    .replace('__HOSTED__', hosted ? 'true' : 'false')
    .replace('__MARKUP_JSON__', JSON.stringify(MARKUP));
}

function css() {
  return fs.readFileSync(STYLES, 'utf8') + EXTRA_CSS;
}

function dataScript(payload) {
  // </script> 出現在資料裡會提早結束 script 區塊，要跳脫
  return `<script id="data" type="application/json">${JSON.stringify(payload).replace(/<\//g, '<\\/')}</script>`;
}

/** 單一 HTML 檔：樣式、程式、資料全部內嵌。 */
function buildStaticHtml(data) {
  const payload = preparePayload(data);
  return `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<title>阿爾法產品清單</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<style>
${css()}
</style>
</head>
<body>${MARKUP}
${dataScript(payload)}
<script>
${appJs(false)}
</script>
</body>
</html>
`;
}

/**
 * 發布到 claude.ai 用的檔案。index.html 不含 doctype/html/head/body 外殼
 *（發布工具會自己包），app.js 內的 renderIndex 則會產出完整文件供頁面自我更新。
 */
function buildHosted(data, payloadOverrides = {}) {
  const payload = { ...preparePayload(data), ...payloadOverrides };
  const index = `<title>阿爾法產品清單</title>
<link rel="stylesheet" href="styles.css">
${MARKUP}
${dataScript(payload)}
<script src="app.js"></script>
`;
  return { 'index.html': index, 'app.js': appJs(true), 'styles.css': css() };
}

module.exports = { buildStaticHtml, buildHosted, preparePayload };
