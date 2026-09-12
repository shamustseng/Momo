'use strict';

const LABELS = { momo: 'momo 購物網', alphaplus: 'Alpha Plus 官網' };
const SOURCE_ORDER = ['momo', 'alphaplus'];

const state = {
  sources: {},
  keywords: [],
  source: 'all',
  q: '',
  sort: 'default',
  onlyListed: false,
  polling: null,
};

const $ = (id) => document.getElementById(id);

/* ---------------- 資料 ---------------- */

async function api(path, options) {
  const res = await fetch(path, options);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `伺服器回應 ${res.status}`);
  return payload;
}

async function load() {
  const data = await api('/api/products');
  state.sources = data.sources || {};
  state.keywords = data.keywords || [];
  $('keywords').value = state.keywords.join('\n');
  render();
  if (data.job && data.job.running) startPolling();
}

/* ---------------- 篩選 ---------------- */

function visibleProducts() {
  let products = [];
  for (const key of SOURCE_ORDER) {
    if (state.source !== 'all' && state.source !== key) continue;
    const source = state.sources[key];
    if (!source) continue;
    for (const p of source.products || []) products.push({ ...p, source: p.source || key });
  }

  const terms = state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) {
    products = products.filter((p) => {
      const hay = `${p.name} ${p.sku || ''} ${(p.keywords || []).join(' ')}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  if (state.onlyListed) products = products.filter((p) => !p.status);

  const byPrice = (a, b, dir) => {
    const av = a.price ?? Infinity;
    const bv = b.price ?? Infinity;
    return av === bv ? a.name.localeCompare(b.name, 'zh-TW') : (av - bv) * dir;
  };
  if (state.sort === 'price-asc') products.sort((a, b) => byPrice(a, b, 1));
  else if (state.sort === 'price-desc') products.sort((a, b) => byPrice(b, a, 1));
  else if (state.sort === 'name') products.sort((a, b) => a.name.localeCompare(b.name, 'zh-TW'));

  return products;
}

/* ---------------- 畫面 ---------------- */

function fmtPrice(price) {
  return price === null || price === undefined ? null : `$${Number(price).toLocaleString('zh-TW')}`;
}

function fmtTime(iso) {
  if (!iso) return '尚未抓取';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '尚未抓取';
  // 固定用台北時間顯示，免得同事電腦時區不同就對不上
  return d.toLocaleString('zh-TW', {
    hour12: false, timeZone: 'Asia/Taipei',
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function renderStatus() {
  const row = $('status-row');
  row.replaceChildren();
  for (const key of SOURCE_ORDER) {
    const source = state.sources[key];
    if (!source) continue;
    const card = el('div', `status-card ${key}`);

    const head = el('h3');
    const stale = source.seeded || !source.updatedAt;
    const dot = el('span', `dot${source.error ? ' bad' : stale ? ' stale' : ''}`);
    head.append(dot, document.createTextNode(source.label || LABELS[key] || key));
    card.append(head);

    const count = (source.products || []).length;
    card.append(el('p', 'meta', `${count} 件商品　·　更新：${fmtTime(source.updatedAt)}`));

    if (source.error) card.append(el('p', 'msg bad', `抓取失敗：${source.error}`));
    for (const warning of source.warnings || []) card.append(el('p', 'msg', warning));

    row.append(card);
  }
}

function renderResults(products) {
  const container = $('results');
  container.replaceChildren();

  if (!products.length) {
    const empty = el('div', 'panel empty');
    empty.append(
      el('p', null, state.q ? `找不到符合「${state.q}」的商品。` : '目前沒有商品資料。'),
      el('p', null, '可以按右上角「重新抓取兩邊」取得最新清單。')
    );
    container.append(empty);
    return;
  }

  const grouped = state.sort === 'default' && state.source === 'all';
  if (!grouped) {
    products.forEach((p) => container.append(productCard(p)));
    return;
  }
  for (const key of SOURCE_ORDER) {
    const list = products.filter((p) => p.source === key);
    if (!list.length) continue;
    const head = el('div', 'group-head');
    head.append(el('h2', null, LABELS[key] || key), el('span', 'n', `${list.length} 件`));
    container.append(head);
    list.forEach((p) => container.append(productCard(p)));
  }
}

function productCard(product) {
  const card = el('div', 'card');

  const link = el('a', 'name', product.name);
  link.href = product.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  card.append(link);

  const price = fmtPrice(product.price);
  card.append(el('span', price ? 'price' : 'price none', price || '價格未取得'));

  const actions = el('div', 'row-actions');
  const copy = el('button', 'btn btn-quiet', '複製連結');
  copy.addEventListener('click', () => copyText(product.url, '已複製連結'));
  actions.append(copy);
  card.append(actions);

  const sub = el('div', 'sub');
  sub.append(el('span', `pill ${product.source}`, LABELS[product.source] || product.source));
  if (product.sku) sub.append(el('span', 'pill', `編號 ${product.sku}`));
  if (product.status) sub.append(el('span', 'pill warn', product.status));
  for (const keyword of product.keywords || []) sub.append(el('span', 'pill', keyword));
  card.append(sub);

  return card;
}

function render() {
  const products = visibleProducts();
  renderStatus();
  renderResults(products);
  const total = SOURCE_ORDER.reduce((n, k) => n + ((state.sources[k] || {}).products || []).length, 0);
  $('count').textContent = `顯示 ${products.length} / 共 ${total} 件`;
}

/* ---------------- 重新抓取 ---------------- */

async function refresh() {
  const btn = $('refresh-btn');
  btn.disabled = true;
  btn.textContent = '抓取中…';
  try {
    const source = state.source === 'all' ? 'all' : state.source;
    await api(`/api/refresh?source=${encodeURIComponent(source)}`, { method: 'POST' });
    startPolling();
  } catch (err) {
    toast(err.message);
    resetRefreshButton();
  }
}

function resetRefreshButton() {
  const btn = $('refresh-btn');
  btn.disabled = false;
  btn.textContent = state.source === 'all' ? '重新抓取兩邊' : `重新抓取 ${LABELS[state.source]}`;
}

function startPolling() {
  $('job-panel').hidden = false;
  $('refresh-btn').disabled = true;
  $('refresh-btn').textContent = '抓取中…';
  if (state.polling) clearInterval(state.polling);
  state.polling = setInterval(pollJob, 1200);
  pollJob();
}

async function pollJob() {
  let job;
  try {
    job = await api('/api/job');
  } catch {
    return;
  }
  const log = $('job-log');
  log.replaceChildren();
  for (const entry of job.log || []) log.append(el('li', null, entry.message));

  if (job.running) {
    $('job-title').textContent = `正在抓取：${(job.sources || []).map((s) => LABELS[s] || s).join('、')}`;
    return;
  }

  clearInterval(state.polling);
  state.polling = null;
  $('job-panel').querySelector('.spinner').style.visibility = 'hidden';
  $('job-title').textContent = job.error ? `抓取結束（有錯誤：${job.error}）` : '抓取完成';
  resetRefreshButton();
  await load();
  toast(job.error ? '抓取結束，但有錯誤，請看下方明細。' : '已更新為最新資料');
  setTimeout(() => {
    $('job-panel').hidden = true;
    $('job-panel').querySelector('.spinner').style.visibility = '';
  }, 6000);
}

/* ---------------- 輸出 ---------------- */

function exportQuery() {
  const params = new URLSearchParams();
  if (state.source !== 'all') params.set('source', state.source);
  if (state.q.trim()) params.set('q', state.q.trim());
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function download(kind) {
  window.location.href = `/api/export.${kind}${exportQuery()}`;
  toast({ csv: '已開始下載 CSV', md: '已開始下載 Markdown', html: '已開始下載單檔網頁' }[kind]);
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    // 非 https 或舊瀏覽器沒有剪貼簿權限時的備援
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    toast(ok ? message : '複製失敗，請改用下載 CSV');
  }
}

function copyList(linksOnly) {
  const products = visibleProducts();
  if (!products.length) return toast('目前沒有可複製的商品');
  const text = products
    .map((p) => {
      if (linksOnly) return p.url;
      const price = fmtPrice(p.price) || '價格未取得';
      const status = p.status ? `｜${p.status}` : '';
      return `${p.name}｜${price}${status}｜${p.url}`;
    })
    .join('\n');
  copyText(text, `已複製 ${products.length} 筆`);
}

let toastTimer = null;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
}

/* ---------------- 事件 ---------------- */

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

$('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  state.source = tab.dataset.source;
  for (const node of $('tabs').children) node.classList.toggle('is-active', node === tab);
  resetRefreshButton();
  render();
});

$('q').addEventListener('input', debounce((event) => {
  state.q = event.target.value;
  render();
}, 160));

$('sort').addEventListener('change', (event) => { state.sort = event.target.value; render(); });
$('only-listed').addEventListener('change', (event) => { state.onlyListed = event.target.checked; render(); });
$('refresh-btn').addEventListener('click', refresh);

$('export-btn').addEventListener('click', () => {
  const menu = $('export-menu');
  menu.hidden = !menu.hidden;
  $('export-btn').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.menu')) {
    $('export-menu').hidden = true;
    $('export-btn').setAttribute('aria-expanded', 'false');
  }
});
$('export-menu').addEventListener('click', (event) => {
  const action = event.target.dataset.export;
  if (!action) return;
  $('export-menu').hidden = true;
  if (action === 'csv' || action === 'md' || action === 'html') download(action);
  else copyList(action === 'links');
});

$('job-toggle').addEventListener('click', () => {
  const log = $('job-log');
  log.hidden = !log.hidden;
  $('job-toggle').textContent = log.hidden ? '顯示明細' : '隱藏明細';
});

$('save-keywords').addEventListener('click', async () => {
  const keywords = $('keywords').value.split(/[\n,、，]+/).map((k) => k.trim()).filter(Boolean);
  try {
    const result = await api('/api/keywords', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords }),
    });
    state.keywords = result.keywords;
    $('keywords').value = result.keywords.join('\n');
    const saved = $('keywords-saved');
    saved.hidden = false;
    setTimeout(() => { saved.hidden = true; }, 2000);
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== $('q')) {
    event.preventDefault();
    $('q').focus();
  }
});

load().catch((err) => toast(`載入失敗：${err.message}`));
