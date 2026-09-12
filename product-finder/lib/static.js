'use strict';

const fs = require('fs');
const path = require('path');
const { LABEL } = require('./export');

const STYLES = path.join(__dirname, '..', 'public', 'styles.css');

/**
 * 把目前的商品資料打包成一個不需要伺服器的 HTML 檔：
 * 樣式、程式、資料全部內嵌，雙擊即可開，搜尋／切換來源／複製連結都在瀏覽器端完成。
 * 適合丟到共用資料夾或直接寄給同事。
 */
function buildStaticHtml(data) {
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
  const generatedAt = new Date().toISOString();
  // </script> 出現在資料裡會提早結束 script 區塊，要跳脫
  const payload = JSON.stringify({ generatedAt, sources }).replace(/<\//g, '<\\/');
  const css = fs.readFileSync(STYLES, 'utf8');

  return `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<title>阿爾法產品清單</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<style>
${css}
.static-note{ font-size:12.5px; color:var(--ink-muted); margin:0; }
.card .sub .stamp{ margin-left:auto; }
.copy-hint{ font-size:12px; color:var(--ink-faint); margin:8px 2px 0; }
</style>
</head>
<body>
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
      <div class="menu">
        <button class="btn btn-primary" id="export-btn" aria-haspopup="true" aria-expanded="false">一鍵輸出</button>
        <div class="menu-panel" id="export-menu" hidden>
          <button data-export="clip">複製全部名稱＋價格＋連結</button>
          <button data-export="links">只複製連結</button>
          <button data-export="csv">下載 CSV（Excel）</button>
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

  <section class="status-row" id="status-row"></section>
  <section id="results" class="results" aria-live="polite"></section>

  <footer class="foot">
    <p id="generated"></p>
    <p>這是單檔版清單，資料固定在產出當下；要更新請在 product-finder 重新抓取後再輸出一次。價格與上架狀態以各站台當下顯示為準。</p>
  </footer>
</main>
<div class="toast" id="toast" hidden></div>

<script id="data" type="application/json">${payload}</script>
<script>
'use strict';
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
function fmtTime(iso) {
  if (!iso) return '尚未抓取';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '尚未抓取';
  return d.toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function visible() {
  let list = [];
  for (const key of ORDER) {
    if (state.source !== 'all' && state.source !== key) continue;
    const s = DATA.sources[key];
    if (s) list.push(...s.products);
  }
  const terms = state.q.trim().toLowerCase().split(/\\s+/).filter(Boolean);
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
    box.append(h, el('p', 'meta', s.products.length + ' 件商品　·　資料時間：' + fmtTime(s.updatedAt)));
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
}

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
    toast(ok ? msg : '複製失敗，請改用下載 CSV');
  }
}
function csvCell(v) { const s = v == null ? '' : String(v); return /[",\\n\\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function exportAction(kind) {
  const list = visible();
  if (!list.length) return toast('目前沒有可輸出的商品');
  if (kind === 'links') return copyText(list.map((p) => p.url).join('\\n'), '已複製 ' + list.length + ' 個連結');
  if (kind === 'clip') return copyText(list.map((p) => p.name + '｜' + (fmtPrice(p.price) || '價格未取得') + (p.status ? '｜' + p.status : '') + '｜' + p.url).join('\\n'), '已複製 ' + list.length + ' 筆');
  const rows = [['來源', '商品名稱', '售價(TWD)', '商品連結', '商品編號', '狀態', '對應關鍵字']];
  for (const p of list) rows.push([LABELS[p.source], p.name, p.price ?? '', p.url, p.sku, p.status || '上架中', p.keywords.join(' / ')]);
  const csv = '\\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\\r\\n') + '\\r\\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = '產品清單_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.csv';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('已開始下載 CSV');
}

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

$('generated').textContent = '此檔產出時間：' + fmtTime(DATA.generatedAt);
render();
</script>
</body>
</html>
`;
}

module.exports = { buildStaticHtml };
