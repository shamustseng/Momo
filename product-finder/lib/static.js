'use strict';

const fs = require('fs');
const path = require('path');
const { LABEL } = require('./export');

const STYLES = path.join(__dirname, '..', 'public', 'styles.css');

/**
 * 把商品資料打包成不需要伺服器的網頁。兩種產物共用同一份版面與程式：
 *  - buildStaticHtml(data)：單一 HTML 檔，樣式／程式／資料全內嵌，雙擊即開。
 *  - buildSite(data)：GitHub Pages 網站版，「重新搜尋」直接呼叫 GitHub API 觸發抓取並顯示進度。
 *  - buildHosted(data)：claude.ai 唯讀副本（沙箱不能連 GitHub），指向網站版。
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
        prices: p.prices || null,
        url: p.url, status: p.status || '', keywords: p.keywords || [],
      })),
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    refreshStatus: null,   // 'failed'：這次重抓整個失敗、沿用上次的資料；null：正常
    refreshError: null,
    sources,
  };
}

const EXTRA_CSS = `
.static-note{ font-size:12.5px; color:var(--ink-muted); margin:0; }
.refresh-banner{ margin-top:14px; padding:12px 16px; display:flex; align-items:center; gap:10px; font-size:13.5px; }
.refresh-banner .spinner{ display:inline-block; }
.refresh-banner.stale .spinner, .refresh-banner.failed .spinner{ display:none; }
.refresh-banner.failed{ background:var(--danger-bg, #fdecea); color:var(--danger-ink, #8a1f11); border-color:var(--danger-border, #f3b4ab); }
.copy-overlay{
  position:fixed; inset:0; z-index:60; background:rgba(0,0,0,.45);
  display:flex; align-items:center; justify-content:center; padding:20px;
}
.copy-panel{ width:min(760px,100%); padding:16px; display:flex; flex-direction:column; gap:10px; }
.copy-hint{ margin:0; font-size:13.5px; font-weight:700; }
.copy-panel textarea{
  width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:9px;
  padding:10px 12px; font-family:var(--font-mono); font-size:12px; line-height:1.6; resize:vertical;
}
.copy-actions{ display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; }
.refresh-banner #refresh-link{ margin-left:auto; white-space:nowrap; font-weight:700; }
.gh-steps{ margin:0; padding-left:20px; font-size:13px; line-height:1.8; }
.gh-panel input{ width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:9px; padding:9px 12px; font-family:var(--font-mono); font-size:13px; }
.gh-msg{ margin:0; font-size:13px; min-height:1.2em; }
.gh-msg.bad{ color:var(--bad); }
.gh-msg.good{ color:var(--good); }
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
          <button data-export="csv">下載 CSV（Excel）</button>
          <button data-export="md">下載 Markdown</button>
          <button data-export="clip">複製全部名稱＋價格＋連結</button>
          <button data-export="links">只複製連結</button>
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
    <a id="refresh-link" target="_blank" rel="noopener noreferrer" hidden>查看 GitHub 紀錄</a>
  </section>

  <section class="status-row" id="status-row"></section>
  <section id="results" class="results" aria-live="polite"></section>

  <footer class="foot">
    <p id="generated"></p>
    <p id="auto-note" hidden></p>
    <p id="gh-settings-row" hidden><button class="btn btn-quiet" id="gh-settings">GitHub 權杖設定</button></p>
    <p>資料由程式抓取 momo 與 Alpha Plus 官網商品頁；momo 商品列出商品頁上的促銷價、市售價與限時折後價（有限時活動時才有），排序與對帳以促銷價為準；上架狀態以各站台當下顯示為準。</p>
  </footer>
</main>
<div class="toast" id="toast" hidden></div>

<div class="copy-overlay" id="copy-overlay" hidden>
  <div class="panel copy-panel">
    <p class="copy-hint" id="copy-hint"></p>
    <textarea id="copy-area" rows="12" readonly spellcheck="false"></textarea>
    <div class="copy-actions">
      <button class="btn btn-primary" id="copy-retry">再試一次自動複製</button>
      <button class="btn" id="copy-close">關閉</button>
    </div>
  </div>
</div>

<div class="copy-overlay" id="gh-overlay" hidden>
  <div class="panel copy-panel gh-panel">
    <p class="copy-hint">第一次使用「重新搜尋」：設定 GitHub 權杖（只要做一次，存在這台電腦的瀏覽器裡）</p>
    <ol class="gh-steps">
      <li>按 <a id="gh-token-link" target="_blank" rel="noopener noreferrer">建立權杖</a>（會開 GitHub，需已登入）。</li>
      <li>Repository access 選 <b>Only select repositories</b> → 選 <b>shamustseng/Momo</b>。</li>
      <li>Permissions → Repository permissions：<b>Actions</b> 設 <b>Read and write</b>、<b>Contents</b> 設 <b>Read-only</b>。</li>
      <li>按 Generate token，把產生的 <code>github_pat_…</code> 貼到下面，按「儲存並測試」。</li>
    </ol>
    <input type="password" id="gh-token" placeholder="github_pat_…" autocomplete="off" spellcheck="false">
    <p class="gh-msg" id="gh-msg"></p>
    <div class="copy-actions">
      <button class="btn" id="gh-clear">清除權杖</button>
      <button class="btn" id="gh-close">關閉</button>
      <button class="btn btn-primary" id="gh-save">儲存並測試</button>
    </div>
  </div>
</div>
`;

/** 頁面程式。\`MARKUP_JSON\` 與 \`HOSTED\` 兩個佔位符在打包時填入。 */
const APP_JS = String.raw`'use strict';
const HOSTED = __HOSTED__;
// 網站版（GitHub Pages）：{ mode:'site', repo, workflow, ref, dataBranch, tokenUrl }
// claude.ai 版：{ mode:'artifact', siteUrl }；單檔版：null
const LIVE = __LIVE_JSON__;
let DATA = JSON.parse(document.getElementById('data').textContent);
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

// momo 有三種標價：促銷價是對帳用的主價；市售價畫掉當參考；限時折後價只有限時活動時才有，另外標出。
const PRICE_ROWS = [['promo', '促銷價'], ['list', '市售價'], ['flash', '限時折後價']];
function priceRows(p) {
  const pr = p.prices || {};
  return PRICE_ROWS.filter(([k]) => pr[k] !== null && pr[k] !== undefined).map(([k, label]) => [k, label, pr[k]]);
}
function priceBlock(p) {
  const rows = priceRows(p);
  if (!rows.length) { const price = fmtPrice(p.price); return el('span', price ? 'price' : 'price none', price || '價格未取得'); }
  const box = el('div', 'prices');
  for (const [kind, label, value] of rows) {
    const line = el('span', 'price ' + kind);
    line.append(el('span', 'label', label), document.createTextNode(fmtPrice(value)));
    box.append(line);
  }
  return box;
}
function priceText(p) {
  const rows = priceRows(p);
  return rows.length ? rows.map(([, label, v]) => label + ' ' + fmtPrice(v)).join('｜') : (fmtPrice(p.price) || '價格未取得');
}

function card(p) {
  const c = el('div', 'card');
  const a = el('a', 'name', p.name); a.href = p.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  c.append(a);
  c.append(priceBlock(p));
  const actions = el('div', 'row-actions');
  const copy = el('button', 'btn btn-quiet', '複製連結');
  copy.addEventListener('click', () => copyText(p.url, '已複製連結'));
  actions.append(copy); c.append(actions);
  const sub = el('div', 'sub');
  sub.append(el('span', 'pill ' + p.source, LABELS[p.source]));
  if (p.sku) sub.append(el('span', 'pill', p.source === 'momo' ? 'momo 品號 ' + p.sku : '編號 ' + p.sku));
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

/* ---------- 重新搜尋與狀態橫幅 ---------- */

/**
 * 網站版的「重新搜尋」直接呼叫 GitHub API 觸發抓取，再問 GitHub 這次跑到哪了，
 * 橫幅顯示的是 GitHub 回報的真實狀態，不是猜的：
 *   starting → queued（排隊）→ running（抓取中）→ 成功就換上新資料；失敗／逾時就停在紅色橫幅。
 * 需要一把只開「Actions 讀寫、Contents 唯讀」的 GitHub 權杖，只存在這台電腦的瀏覽器（localStorage）。
 */
const GH_API = 'https://api.github.com';
const TOKEN_KEY = 'product-finder:github-token';
const JOB_LIMIT_MS = 10 * 60 * 1000;
const POLL_MS = 4000;
let job = null;   // null | { phase, startedAt, baselineId, runId, runUrl, message }
let jobTicker = null;

function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* 無痕模式存不了，只在這次開啟有效 */ } memToken = t; }
let memToken = '';
const token = () => getToken() || memToken;

function ghMessage(status) {
  if (status === 401) return 'GitHub 權杖無效或已過期，請按「GitHub 權杖設定」重新設定';
  if (status === 403) return 'GitHub 權杖沒有足夠權限（Actions 要設 Read and write），或 GitHub 暫時限流';
  if (status === 404) return 'GitHub 權杖看不到 ' + LIVE.repo + '（建立權杖時要在 Repository access 選它）';
  if (status === 422) return 'GitHub 拒絕觸發這個 workflow（' + LIVE.workflow + '）';
  return 'GitHub 回應 HTTP ' + status;
}

async function gh(path, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ' + token() };
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (opts.accept) headers.Accept = opts.accept;
  const res = await fetch(GH_API + path, { method: opts.method || 'GET', headers, body: opts.body, cache: 'no-store' });
  if (!res.ok) { const e = new Error(ghMessage(res.status)); e.status = res.status; throw e; }
  if (res.status === 204) return null;
  return opts.accept && opts.accept.includes('raw') ? res.text() : res.json();
}

const runsPath = () => '/repos/' + LIVE.repo + '/actions/workflows/' + encodeURIComponent(LIVE.workflow) + '/runs?per_page=10';

function renderRefreshState() {
  const banner = $('refresh-banner');
  const text = $('refresh-text');
  const link = $('refresh-link');
  const btn = $('refresh-btn');
  banner.classList.remove('stale', 'failed');
  link.hidden = true;
  const busy = job && ['starting', 'queued', 'running'].includes(job.phase);
  btn.disabled = !!busy;
  btn.textContent = busy ? '搜尋中…' : '重新搜尋';
  if (job && job.runUrl) { link.href = job.runUrl; link.hidden = false; }
  if (busy) {
    const sec = Math.round((Date.now() - job.startedAt) / 1000);
    banner.hidden = false;
    text.textContent = job.phase === 'starting' ? '正在通知 GitHub 開始抓取…'
      : job.phase === 'queued' ? 'GitHub 已收到，排隊等機器中…（已 ' + sec + ' 秒）'
      : '正在抓取 momo 與 Alpha Plus 官網…（已 ' + sec + ' 秒，通常 1 分鐘內完成）';
    return;
  }
  if (job && job.phase === 'failed') {
    banner.hidden = false;
    banner.classList.add('failed');
    text.textContent = '重新搜尋失敗：' + job.message + '。畫面上仍是 ' + fmtTime(DATA.generatedAt, true) + ' 的資料。';
    return;
  }
  if (DATA.refreshStatus === 'failed') {
    banner.hidden = false;
    banner.classList.add('failed');
    text.textContent = '上次重新抓取失敗：' + (DATA.refreshError || '發生未知錯誤') + '。目前顯示的是上一次成功的資料（' + fmtTime(DATA.generatedAt, true) + '）。';
    return;
  }
  banner.hidden = true;
}

function setJob(patch) {
  job = patch === null ? null : { ...(job || {}), ...patch };
  const busy = job && ['starting', 'queued', 'running'].includes(job.phase);
  if (busy && !jobTicker) jobTicker = setInterval(renderRefreshState, 1000);
  if (!busy && jobTicker) { clearInterval(jobTicker); jobTicker = null; }
  renderRefreshState();
}

async function onRefresh() {
  if (job && ['starting', 'queued', 'running'].includes(job.phase)) return;
  if (!token()) { openTokenPanel('按「重新搜尋」之前，要先設定一次 GitHub 權杖。'); return; }
  setJob({ phase: 'starting', startedAt: Date.now(), baselineId: 0, runId: null, runUrl: null, message: '' });
  try {
    // 先記下目前最新一次執行的 id；觸發後出現 id 比它大的，就是這次的
    const before = await gh(runsPath());
    job.baselineId = Math.max(0, ...before.workflow_runs.map((r) => r.id));
    await gh('/repos/' + LIVE.repo + '/actions/workflows/' + encodeURIComponent(LIVE.workflow) + '/dispatches', {
      method: 'POST', body: JSON.stringify({ ref: LIVE.ref }),
    });
    setJob({ phase: 'queued' });
    pollRun();
  } catch (err) {
    failJob(err.message || String(err), err.status);
  }
}

function failJob(message, status) {
  setJob({ phase: 'failed', message });
  if (status === 401 || status === 404) openTokenPanel(message);
}

async function pollRun() {
  while (job && ['queued', 'running'].includes(job.phase)) {
    if (Date.now() - job.startedAt > JOB_LIMIT_MS) { failJob('等了 10 分鐘 GitHub 還沒跑完，請按「查看 GitHub 紀錄」確認'); return; }
    await new Promise((r) => setTimeout(r, POLL_MS));
    let run;
    try {
      const d = await gh(runsPath());
      run = d.workflow_runs.find((r) => (job.runId ? r.id === job.runId : r.id > job.baselineId));
    } catch (err) {
      if (err.status === 401 || err.status === 403 || err.status === 404) { failJob(err.message, err.status); return; }
      continue;   // 網路一時不穩，下一輪再問
    }
    if (!run) continue;   // GitHub 還沒把這次排進列表
    setJob({ runId: run.id, runUrl: run.html_url, phase: run.status === 'completed' ? job.phase : run.status === 'in_progress' ? 'running' : 'queued' });
    if (run.status !== 'completed') continue;
    const fresh = await loadLatestData();
    if (run.conclusion === 'success' && fresh) {
      setJob(null);
      toast('已更新：' + fmtTime(DATA.generatedAt) + ' 抓到 ' + ORDER.reduce((n, k) => n + ((DATA.sources[k] || { products: [] }).products.length), 0) + ' 件商品');
    } else if (run.conclusion === 'success') {
      failJob('抓取成功，但讀不到新資料，請重新整理本頁');
    } else {
      failJob('GitHub 這次抓取沒有成功（' + (run.conclusion || '未知') + '），按「查看 GitHub 紀錄」可看原因');
    }
    return;
  }
}

/**
 * 讀最新的 data.json。有權杖就走 GitHub API（沒有 CDN 快取，剛推上去就讀得到）；
 * 沒有權杖就讀網站上同一份（GitHub Pages 最多會快取幾分鐘）。讀到新的就換上並重畫。
 */
async function loadLatestData() {
  let fresh = null;
  if (token()) {
    try {
      const raw = await gh('/repos/' + LIVE.repo + '/contents/data.json?ref=' + encodeURIComponent(LIVE.dataBranch), { accept: 'application/vnd.github.raw+json' });
      fresh = JSON.parse(raw);
    } catch { fresh = null; }
  }
  if (!fresh) {
    try {
      const res = await fetch('data.json?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) fresh = await res.json();
    } catch { fresh = null; }
  }
  if (!fresh || !fresh.sources) return null;
  if (fresh.generatedAt !== DATA.generatedAt) {
    DATA = fresh;
    $('generated').textContent = '資料產出時間：' + fmtTime(DATA.generatedAt, true);
    render();
  }
  return fresh;
}

/* ---------- GitHub 權杖設定 ---------- */

function openTokenPanel(msg) {
  $('gh-overlay').hidden = false;
  $('gh-token').value = '';
  const m = $('gh-msg');
  m.className = 'gh-msg' + (msg ? ' bad' : '');
  m.textContent = msg || (token() ? '已設定權杖。要換新的就貼上後按「儲存並測試」。' : '');
  $('gh-token').focus();
}

async function saveToken() {
  const value = $('gh-token').value.trim();
  const m = $('gh-msg');
  if (!value) { m.className = 'gh-msg bad'; m.textContent = '請先貼上權杖'; return; }
  const previous = token();
  setToken(value);
  m.className = 'gh-msg'; m.textContent = '測試中…';
  try {
    await gh('/repos/' + LIVE.repo + '/actions/workflows/' + encodeURIComponent(LIVE.workflow));
    m.className = 'gh-msg good'; m.textContent = '可以用了！之後按「重新搜尋」就會直接開始抓取。';
    setTimeout(() => { $('gh-overlay').hidden = true; }, 1200);
  } catch (err) {
    setToken(previous);
    m.className = 'gh-msg bad'; m.textContent = '這把權杖不能用：' + (err.message || err);
  }
}

function setupSite() {
  const btn = $('refresh-btn');
  btn.hidden = false;
  btn.addEventListener('click', onRefresh);
  $('gh-token-link').href = LIVE.tokenUrl;
  $('gh-settings-row').hidden = false;
  $('gh-settings').addEventListener('click', () => openTokenPanel());
  $('gh-save').addEventListener('click', saveToken);
  $('gh-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveToken(); });
  $('gh-close').addEventListener('click', () => { $('gh-overlay').hidden = true; });
  $('gh-clear').addEventListener('click', () => { setToken(''); $('gh-msg').className = 'gh-msg'; $('gh-msg').textContent = '已清除。'; });
  const note = $('auto-note');
  note.hidden = false;
  note.textContent = '按「重新搜尋」會立刻請 GitHub 重新抓取 momo 與官網（約 1 分鐘），狀態直接顯示在上方；開啟本頁會自動載入最近一次抓取的結果。';
}

function setupArtifactNote() {
  const note = $('auto-note');
  note.hidden = false;
  note.textContent = '';
  note.append(document.createTextNode('這是 claude.ai 上的唯讀副本，資料不會自動更新。要重新搜尋請開正式網站：'));
  const a = el('a', null, LIVE.siteUrl);
  a.href = LIVE.siteUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
  note.append(a);
}

let downloadsApi = null;

/**
 * 三種版本：
 *  - 網站版（GitHub Pages）：一般網頁，可以直接呼叫 GitHub API，「重新搜尋」在這裡。
 *  - claude.ai 版：沙箱裡不能連 GitHub，只顯示發布當時的資料，並指向網站版。
 *    downloads 能力用來存 CSV（檢視器不允許頁面自行下載）。
 *  - 單檔版：什麼都不連，內嵌的資料就是全部。
 */
async function setupCapabilities() {
  if (LIVE && LIVE.mode === 'site') {
    setupSite();
    await loadLatestData();
  }
  if (LIVE && LIVE.mode === 'artifact' && LIVE.siteUrl) setupArtifactNote();
  if (!HOSTED || !window.claude || typeof window.claude.use !== 'function') return;
  downloadsApi = await window.claude.use('downloads').catch(() => null);
}

/* ---------- 輸出 ---------- */

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
/**
 * 複製到剪貼簿。線上版是沙箱 iframe，瀏覽器常會擋掉自動複製，
 * 所以兩層備援都失敗時改開面板讓使用者自己按 Ctrl+C，不會按了沒反應。
 */
async function copyText(text, msg) {
  if (await tryCopy(text)) { toast(msg); return true; }
  showCopyPanel(text, '瀏覽器擋住了自動複製，請按 Ctrl+C（Mac 按 ⌘+C）複製下面的內容：');
  return false;
}

async function tryCopy(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 往下試舊方法 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

function showCopyPanel(text, hint) {
  $('copy-hint').textContent = hint;
  const area = $('copy-area');
  area.value = text;
  $('copy-overlay').hidden = false;
  area.focus();
  area.select();
}
function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function buildCsv(list) {
  const rows = [['來源', '商品名稱', '售價／促銷價(TWD)', '市售價(TWD)', '限時折後價(TWD)', '商品連結', 'momo 品號', '狀態', '對應關鍵字']];
  for (const p of list) {
    const pr = p.prices || {};
    rows.push([LABELS[p.source], p.name, p.price ?? '', pr.list ?? '', pr.flash ?? '', p.url, p.source === 'momo' ? p.sku : '', p.status || '上架中', p.keywords.join(' / ')]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
function buildMarkdown(list) {
  const groups = new Map();
  for (const p of list) {
    if (!groups.has(p.source)) groups.set(p.source, []);
    groups.get(p.source).push(p);
  }
  const out = ['# 阿爾法餐飲 產品與連結清單', ''];
  for (const [source, items] of groups) {
    out.push('## ' + LABELS[source] + '（' + items.length + ' 筆）');
    const stamp = (DATA.sources[source] || {}).updatedAt;
    if (stamp) out.push('資料時間：' + fmtTime(stamp, true));
    out.push('');
    for (const p of items) {
      const sku = p.source === 'momo' && p.sku ? '｜momo 品號 ' + p.sku : '';
      const status = p.status ? '｜' + p.status : '';
      out.push('- ' + p.name + '｜' + priceText(p) + sku + status + '｜' + p.url);
    }
    out.push('');
  }
  return out.join('\n');
}

function stampName(ext) {
  const d = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
  return '產品清單_' + d.slice(0, 10).replace(/-/g, '') + '.' + ext;
}

async function saveFile(filename, text, mime) {
  if (HOSTED) {
    // 檢視器不允許頁面自行下載，一定要透過 downloads 能力請使用者確認
    if (!downloadsApi) {
      showCopyPanel(text, '這個檢視無法直接存檔，請按 Ctrl+C（Mac 按 ⌘+C）複製下面的內容：');
      return;
    }
    try {
      await downloadsApi.save({ filename, data: text });
      toast('已儲存 ' + filename);
    } catch (err) {
      const code = err && err.code;
      if (code === 'declined') return;                      // 使用者按取消，不用再提示
      if (code === 'rate_limited') { toast('剛剛已有一個存檔視窗，請稍候再試。'); return; }
      showCopyPanel(text, '存檔不可用，請按 Ctrl+C（Mac 按 ⌘+C）複製下面的內容：');
    }
    return;
  }
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('已開始下載 ' + filename);
}

function exportAction(kind) {
  const list = visible();
  if (!list.length) return toast('目前沒有可輸出的商品');
  if (kind === 'links') return copyText(list.map((p) => p.url).join('\n'), '已複製 ' + list.length + ' 個連結');
  if (kind === 'clip') return copyText(list.map((p) => p.name + '｜' + priceText(p) + (p.status ? '｜' + p.status : '') + '｜' + p.url).join('\n'), '已複製 ' + list.length + ' 筆');
  if (kind === 'md') return saveFile(stampName('md'), buildMarkdown(list), 'text/markdown;charset=utf-8');
  return saveFile(stampName('csv'), buildCsv(list), 'text/csv;charset=utf-8');
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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('copy-overlay').hidden) { $('copy-overlay').hidden = true; return; }
  if (e.key === 'Escape' && !$('gh-overlay').hidden) { $('gh-overlay').hidden = true; return; }
  if (e.key === '/' && document.activeElement !== $('q') && document.activeElement !== $('copy-area') && document.activeElement !== $('gh-token')) { e.preventDefault(); $('q').focus(); }
});
$('copy-close').addEventListener('click', () => { $('copy-overlay').hidden = true; });
$('copy-overlay').addEventListener('click', (e) => { if (e.target === $('copy-overlay')) $('copy-overlay').hidden = true; });
$('copy-retry').addEventListener('click', async () => {
  if (await tryCopy($('copy-area').value)) { $('copy-overlay').hidden = true; toast('已複製'); }
  else { $('copy-area').select(); toast('還是不行，請直接按 Ctrl+C'); }
});

$('generated').textContent = '資料產出時間：' + fmtTime(DATA.generatedAt, true);
render();
setupCapabilities();
`;

function appJs(hosted, live = null) {
  return APP_JS
    .replace('__HOSTED__', hosted ? 'true' : 'false')
    .replace('__LIVE_JSON__', JSON.stringify(live));
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
 * 發布到 claude.ai 用的檔案（唯讀副本）。index.html 不含 doctype/html/head/body 外殼（發布工具會自己包）。
 * claude.ai 的沙箱不能連 GitHub，所以這一版不做重新搜尋，只顯示資料並指向網站版。
 * live = { siteUrl }，來自 config.json 的 hosted 區塊。
 */
function buildHosted(data, payloadOverrides = {}, live = null) {
  const payload = { ...preparePayload(data), ...payloadOverrides };
  const index = `<title>阿爾法產品清單</title>
<link rel="stylesheet" href="styles.css">
${MARKUP}
${dataScript(payload)}
<script src="app.js"></script>
`;
  const artifactLive = live && live.siteUrl ? { mode: 'artifact', siteUrl: live.siteUrl } : null;
  return {
    'index.html': index,
    'app.js': appJs(true, artifactLive),
    'styles.css': css(),
    'data.json': JSON.stringify(payload) + '\n',
  };
}

/**
 * 網站版（GitHub Pages）：一般網頁，不在沙箱裡，可以直接呼叫 GitHub API 觸發抓取、讀取結果。
 * 由 GitHub Actions 抓完後推到資料分支，GitHub Pages 從那個分支的根目錄提供。
 * live = { repo, workflow, ref, dataBranch, tokenUrl }。
 */
function buildSite(data, payloadOverrides = {}, live = null) {
  const payload = { ...preparePayload(data), ...payloadOverrides };
  const siteLive = live ? { mode: 'site', repo: live.repo, workflow: live.workflow, ref: live.ref, dataBranch: live.dataBranch, tokenUrl: live.tokenUrl } : null;
  const index = `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<title>阿爾法產品清單</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="styles.css">
</head>
<body>${MARKUP}
${dataScript(payload)}
<script src="app.js"></script>
</body>
</html>
`;
  return {
    'index.html': index,
    'app.js': appJs(false, siteLive),
    'styles.css': css(),
    'data.json': JSON.stringify(payload) + '\n',
    '.nojekyll': '',
  };
}

module.exports = { buildStaticHtml, buildHosted, buildSite, preparePayload };
