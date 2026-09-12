'use strict';

const test = require('node:test');
const assert = require('node:assert');

const momo = require('../lib/momo');
const cyberbiz = require('../lib/cyberbiz');
const { toCsv, toMarkdown } = require('../lib/export');
const { selectProducts } = require('../server');

const NET = { concurrency: 2, delayMs: 0, timeoutMs: 5000, retries: 0 };

/** 用假的 fetch 餵入仿真頁面，驗證整條抓取流程（真站台無法在測試環境連線）。 */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    for (const [pattern, respond] of routes) {
      if (url.includes(pattern)) {
        const result = respond(url);
        return {
          ok: result.status === undefined || result.status < 400,
          status: result.status || 200,
          url,
          text: async () => result.body,
        };
      }
    }
    return { ok: false, status: 404, url, text: async () => '' };
  };
  return calls;
}

const momoListItem = (code, name, price) => `
  <li class="goodsItemLi">
    <a href="/goods/GoodsDetail.jsp?i_code=${code}&osm=Ch1"><img data-original="//i.momoshop.com.tw/${code}.jpg" alt="${name}"></a>
    <a href="/goods/GoodsDetail.jsp?i_code=${code}"><h3 class="prdName">${name}</h3></a>
    <p class="money"><span class="price"><b>${price}</b></span></p>
  </li>`;

test('momo：翻頁、去重、跨關鍵字合併', async () => {
  const calls = stubFetch([
    ['curPage=1&', (url) =>
      url.includes(encodeURIComponent('雞湯大叔'))
        ? { body: `<ul>${momoListItem('15250521', '青花椒辣醬240g', '330')}${momoListItem('15127931', '快樂雞滴雞精禮盒', '650')}</ul>` }
        : { body: `<ul>${momoListItem('15250521', '青花椒辣醬240g', '330')}</ul>` }],
    // 第 2 頁回傳與第 1 頁相同的商品，抓取應在此停止
    ['curPage=2', () => ({ body: `<ul>${momoListItem('15250521', '青花椒辣醬240g', '330')}</ul>` })],
  ]);

  const { products } = await momo.scrape(
    { keywords: ['雞湯大叔', '賴山嶼'], maxPagesPerKeyword: 4 }, NET
  );

  assert.strictEqual(products.length, 2, '兩個關鍵字的重複商品要合併成一筆');
  const sauce = products.find((p) => p.sku === '15250521');
  assert.strictEqual(sauce.price, 330);
  assert.strictEqual(sauce.url, 'https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=15250521');
  assert.deepStrictEqual(sauce.keywords, ['雞湯大叔', '賴山嶼'], '要記錄是哪些關鍵字找到的');
  assert.ok(!calls.some((u) => u.includes('curPage=3')), '沒有新商品就該停止翻頁');
});

test('momo：列表缺欄位時自動補抓商品頁', async () => {
  stubFetch([
    ['searchShop.jsp', () => ({ body: '<a href="/goods/GoodsDetail.jsp?i_code=15689825">看更多</a>' })],
    ['GoodsDetail.jsp', () => ({
      body: `<meta property="og:title" content="399抵499即享券 - momo購物網">
             <meta property="product:price:amount" content="399">
             <meta property="og:image" content="https://i.momoshop.com.tw/v.jpg">`,
    })],
  ]);

  const { products } = await momo.scrape({ keywords: ['賴山嶼'], maxPagesPerKeyword: 1 }, NET);
  assert.strictEqual(products.length, 1);
  assert.strictEqual(products[0].name, '399抵499即享券', '要去掉標題尾巴的站名');
  assert.strictEqual(products[0].price, 399);
  assert.strictEqual(products[0].image, 'https://i.momoshop.com.tw/v.jpg');
});

test('momo：搜尋頁失敗時回報警告而不是整個壞掉', async () => {
  stubFetch([['searchShop.jsp', () => ({ status: 503, body: '' })]]);
  const { products, warnings } = await momo.scrape({ keywords: ['雞湯大叔'], maxPagesPerKeyword: 2 }, NET);
  assert.strictEqual(products.length, 0);
  assert.ok(warnings.some((w) => w.includes('讀取失敗')), '要留下可讀的錯誤訊息');
});

test('官網：優先使用 products.json', async () => {
  stubFetch([
    ['/products.json', (url) => url.includes('page=1')
      ? { body: JSON.stringify({ products: [
          { id: 101, handle: '101-chicken-soup', title: '蛤蜊雞湯 460g', price: 199,
            images: [{ src: 'https://cdn/x.jpg' }], variants: [{ price: 199, available: true }] },
          { id: 102, handle: '102-sold-out', title: '限量禮盒', price: 990,
            variants: [{ price: 990, available: false }] },
        ] }) }
      : { body: JSON.stringify({ products: [] }) }],
  ]);

  const { products, strategy } = await cyberbiz.scrape(
    { origin: 'https://alphaplus.cyberbiz.co', maxProducts: 100 }, NET
  );
  assert.strictEqual(strategy, 'products.json');
  assert.strictEqual(products.length, 2);
  assert.strictEqual(products[0].url, 'https://alphaplus.cyberbiz.co/products/101-chicken-soup');
  assert.strictEqual(products[0].price, 199);
  assert.strictEqual(products[1].status, '售完或未開賣');
});

test('官網：products.json 不可用時改走 sitemap 與商品頁', async () => {
  stubFetch([
    ['/products.json', () => ({ status: 404, body: '' })],
    ['/sitemap.xml', () => ({ body: `<?xml version="1.0"?><sitemapindex>
        <sitemap><loc>https://alphaplus.cyberbiz.co/sitemap-products.xml</loc></sitemap>
      </sitemapindex>` })],
    ['/sitemap-products.xml', () => ({ body: `<urlset>
        <url><loc>https://alphaplus.cyberbiz.co/products/201-mala</loc></url>
        <url><loc>https://alphaplus.cyberbiz.co/zh-TW/products/202-ramen/</loc></url>
        <url><loc>https://alphaplus.cyberbiz.co/categories/7</loc></url>
      </urlset>` })],
    ['/products/201-mala', () => ({ body: `<script type="application/ld+json">
        {"@type":"Product","name":"青花椒辣醬 240g","offers":{"price":"330","availability":"https://schema.org/InStock"}}
      </script>` })],
    ['/products/202-ramen', () => ({ body: `
        <title>東京雞白湯拉麵 - Alpha Plus</title>
        <meta property="og:price:amount" content="248">` })],
  ]);

  const { products, strategy } = await cyberbiz.scrape(
    { origin: 'https://alphaplus.cyberbiz.co', locale: 'zh-TW', maxProducts: 100 }, NET
  );
  assert.strictEqual(strategy, 'sitemap');
  assert.strictEqual(products.length, 2, '分類頁網址不該被當成商品');
  const byName = Object.fromEntries(products.map((p) => [p.name, p]));
  assert.strictEqual(byName['青花椒辣醬 240g'].price, 330);
  assert.strictEqual(byName['東京雞白湯拉麵'].price, 248, '沒有 JSON-LD 時要退回 og: 標籤');
});

test('官網：sitemap 也失敗時改爬分類頁連結', async () => {
  stubFetch([
    ['/products.json', () => ({ status: 404, body: '' })],
    ['sitemap', () => ({ status: 404, body: '' })],
    ['/categories/7', () => ({ body: '<a href="/products/301-gift">禮盒</a>' })],
    ['/products/301-gift', () => ({ body: '<meta property="og:title" content="中秋禮盒"><meta property="product:price:amount" content="880">' })],
    ['alphaplus.cyberbiz.co/', () => ({ body: '<a href="/categories/7">分類</a><a href="/products/301-gift?from=home">禮盒</a>' })],
  ]);

  const { products, strategy } = await cyberbiz.scrape(
    { origin: 'https://alphaplus.cyberbiz.co', locale: 'zh-TW', maxProducts: 100 }, NET
  );
  assert.strictEqual(strategy, 'crawl');
  assert.strictEqual(products.length, 1, '帶 query 的同一商品要去重');
  assert.strictEqual(products[0].price, 880);
});

test('搜尋：名稱、編號、關鍵字都能命中，且多字要全部符合', () => {
  const data = { sources: { momo: { products: [
    { id: 'momo:1', source: 'momo', sku: '15250521', name: '雞湯大叔×賴山嶼 青花椒辣醬240g', price: 330, url: 'u1', keywords: ['賴山嶼'] },
    { id: 'momo:2', source: 'momo', sku: '14614418', name: '東京雞白湯拉麵', price: 248, url: 'u2', keywords: ['雞湯大叔'] },
  ] } } };
  assert.strictEqual(selectProducts(data, { q: '15250521' }).length, 1);
  assert.strictEqual(selectProducts(data, { q: '賴山嶼' }).length, 1);
  assert.strictEqual(selectProducts(data, { q: '辣醬 青花椒' }).length, 1);
  assert.strictEqual(selectProducts(data, { q: '辣醬 拉麵' }).length, 0, '多個字要同時符合');
  assert.strictEqual(selectProducts(data, { source: 'alphaplus' }).length, 0);
});

test('匯出：CSV 會跳脫逗號引號，Markdown 會分來源', () => {
  const products = [
    { source: 'momo', sku: '1', name: '含,逗號與"引號', price: 100, url: 'https://a', status: '', keywords: ['賴山嶼'] },
    { source: 'alphaplus', sku: '2', name: '無價格商品', price: null, url: 'https://b', status: '售完或未開賣', keywords: [] },
  ];
  const csv = toCsv(products);
  assert.ok(csv.startsWith('﻿'), 'Excel 需要 BOM 才不會中文亂碼');
  assert.ok(csv.includes('"含,逗號與""引號"'));
  assert.ok(csv.includes(',上架中,'), '沒有狀態就是上架中');

  const md = toMarkdown(products, { momo: '2026-09-12T00:00:00+08:00' });
  assert.ok(md.includes('## momo 購物網（1 筆）'));
  assert.ok(md.includes('## Alpha Plus 官網（1 筆）'));
  assert.ok(md.includes('價格未取得'));
});

test('重新抓取：抓到 0 筆時保留上一次的資料，不覆蓋', async () => {
  const fs = require('node:fs');
  const store = require('../lib/store');
  const { refresh } = require('../lib/refresh');
  const backup = fs.existsSync(store.CACHE) ? fs.readFileSync(store.CACHE, 'utf8') : null;
  try {
    // 先種一份有資料的快取
    store.save({ version: 1, sources: { momo: { label: 'momo 購物網', updatedAt: '2026-09-01T00:00:00Z', ok: true,
      products: [{ id: 'momo:1', source: 'momo', sku: '1', name: '舊資料', price: 1, url: 'u', keywords: [] }] } } });
    // 全部連線失敗
    globalThis.fetch = async (url) => ({ ok: false, status: 0, url, text: async () => '' });

    const data = await refresh('momo');
    assert.strictEqual(data.sources.momo.products.length, 1, '舊資料要保留');
    assert.strictEqual(data.sources.momo.products[0].name, '舊資料');
    assert.strictEqual(data.sources.momo.updatedAt, '2026-09-01T00:00:00Z', '失敗不該更新時間');
    assert.ok(data.sources.momo.error, '要標記錯誤');
  } finally {
    if (backup === null) fs.rmSync(store.CACHE, { force: true });
    else fs.writeFileSync(store.CACHE, backup);
  }
});
