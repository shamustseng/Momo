'use strict';

const { fetchText, mapLimit } = require('./http');
const H = require('./html');

const ORIGIN = 'https://www.momoshop.com.tw';
const SEARCH = (keyword, page) =>
  `${ORIGIN}/search/searchShop.jsp?keyword=${encodeURIComponent(keyword)}` +
  `&searchType=1&curPage=${page}&_isFuzzy=0&showType=chessboardType`;

const detailUrl = (code) => `${ORIGIN}/goods/GoodsDetail.jsp?i_code=${code}`;

/**
 * 從搜尋結果頁抓出商品。
 * momo 的列表 HTML 會隨改版變動，所以不依賴單一 class：先用 i_code 把頁面切成
 * 一段一段（每段對應一件商品），再在段落內盡量找名稱與價格。任何一段抓不到的
 * 欄位，之後會用商品頁的 meta 標籤補齊。
 */
function parseSearchHtml(html) {
  const hits = [];
  const re = /i_code=(\d{4,})/g;
  let m;
  while ((m = re.exec(html)) !== null) hits.push({ code: m[1], index: m.index });

  const groups = [];
  for (const hit of hits) {
    const last = groups[groups.length - 1];
    if (last && last.code === hit.code) continue;
    groups.push({ code: hit.code, start: hit.index });
  }

  const items = [];
  for (let i = 0; i < groups.length; i++) {
    const start = groups[i].start;
    const end = i + 1 < groups.length ? groups[i + 1].start : html.length;
    const chunk = html.slice(start, end);
    items.push({
      code: groups[i].code,
      name: nameFromChunk(chunk),
      price: priceFromChunk(chunk),
      image: imageFromChunk(chunk),
    });
  }
  return items;
}

function nameFromChunk(chunk) {
  const patterns = [
    /<h3[^>]*class\s*=\s*["'][^"']*prdName[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i,
    /<p[^>]*class\s*=\s*["'][^"']*prdName[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    /<div[^>]*class\s*=\s*["'][^"']*prdName[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<h3[^>]*>([\s\S]*?)<\/h3>/i,
  ];
  for (const re of patterns) {
    const m = chunk.match(re);
    if (m) {
      const text = H.stripTags(m[1]);
      if (text) return text;
    }
  }
  const alt = chunk.match(/<img[^>]*\salt\s*=\s*["']([^"']{4,})["']/i);
  if (alt) return H.decode(alt[1]);
  return '';
}

function priceFromChunk(chunk) {
  const patterns = [
    /<span[^>]*class\s*=\s*["'][^"']*price[^"']*["'][^>]*>([\s\S]{0,120}?)<\/span>/i,
    /<p[^>]*class\s*=\s*["'][^"']*money[^"']*["'][^>]*>([\s\S]{0,200}?)<\/p>/i,
    /<b[^>]*>([\d,]{2,12})<\/b>/i,
  ];
  for (const re of patterns) {
    const m = chunk.match(re);
    if (m) {
      const price = H.toPrice(H.stripTags(m[1]));
      if (price !== null && price > 0) return price;
    }
  }
  return null;
}

function imageFromChunk(chunk) {
  const m =
    chunk.match(/<img[^>]*\sdata-original\s*=\s*["']([^"']+)["']/i) ||
    chunk.match(/<img[^>]*\ssrc\s*=\s*["']((?:https?:)?\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i);
  if (!m) return '';
  return m[1].startsWith('//') ? `https:${m[1]}` : m[1];
}

/** 從商品頁補齊名稱與價格 —— meta 標籤比列表頁的 class 名稱穩定得多。 */
function parseDetailHtml(html) {
  const nodes = H.jsonLd(html);
  const product = H.findType(nodes, 'product');

  let name = H.meta(html, 'og:title') || (product && H.decode(product.name)) || H.title(html);
  name = name.replace(/\s*[-|｜–]\s*momo購物網.*$/i, '').replace(/\s*- momo\s*$/i, '').trim();

  const price =
    H.toPrice(H.meta(html, 'product:price:amount')) ??
    H.toPrice(H.meta(html, 'price')) ??
    (product ? H.priceFromOffers(product.offers) : null) ??
    H.toPrice((html.match(/"price"\s*:\s*"?([\d,.]+)"?/i) || [])[1]);

  const image = H.meta(html, 'og:image') || (product && firstImage(product.image)) || '';

  return { name, price, image };
}

function firstImage(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return firstImage(value[0]);
  if (typeof value === 'object') return firstImage(value.url || value.contentUrl);
  return '';
}

/** 依關鍵字清單搜尋 momo，回傳去重後的商品陣列。 */
async function scrape(sourceConfig, net, log = () => {}) {
  const keywords = (sourceConfig.keywords || []).filter(Boolean);
  const maxPages = Math.max(1, sourceConfig.maxPagesPerKeyword || 3);
  const warnings = [];
  const byCode = new Map();

  for (const keyword of keywords) {
    let found = 0;
    for (let page = 1; page <= maxPages; page++) {
      log(`momo：搜尋「${keyword}」第 ${page} 頁`);
      const res = await fetchText(SEARCH(keyword, page), {
        timeoutMs: net.timeoutMs,
        retries: net.retries,
        referer: `${ORIGIN}/`,
      });
      if (!res.ok) {
        warnings.push(`「${keyword}」第 ${page} 頁讀取失敗：${res.error}`);
        break;
      }
      const items = parseSearchHtml(res.body);
      if (items.length === 0) break;

      let fresh = 0;
      for (const item of items) {
        if (byCode.has(item.code)) {
          const existing = byCode.get(item.code);
          if (!existing.keywords.includes(keyword)) existing.keywords.push(keyword);
          continue;
        }
        fresh++;
        byCode.set(item.code, { ...item, keywords: [keyword] });
      }
      found += fresh;
      if (fresh === 0) break; // 已經翻到重複頁，沒有新商品了
      await new Promise((r) => setTimeout(r, net.delayMs));
    }
    log(`momo：「${keyword}」累計 ${found} 筆新商品`);
    if (found === 0) warnings.push(`「${keyword}」沒有搜到任何商品，請確認關鍵字或 momo 是否改版。`);
  }

  // 名稱或價格缺漏的，逐一開商品頁補齊
  const all = [...byCode.values()];
  const needsDetail = all.filter((item) => !item.name || item.price === null);
  if (needsDetail.length) {
    log(`momo：補抓 ${needsDetail.length} 筆商品頁明細`);
    await mapLimit(needsDetail, net.concurrency, net.delayMs, async (item) => {
      const res = await fetchText(detailUrl(item.code), {
        timeoutMs: net.timeoutMs,
        retries: net.retries,
        referer: `${ORIGIN}/`,
      });
      if (!res.ok) {
        item.status = res.status === 404 ? '已下架或不存在' : `明細讀取失敗（${res.error}）`;
        return;
      }
      const detail = parseDetailHtml(res.body);
      if (!item.name && detail.name) item.name = detail.name;
      if (item.price === null && detail.price !== null) item.price = detail.price;
      if (!item.image && detail.image) item.image = detail.image;
    });
  }

  const products = all
    .filter((item) => item.name)
    .map((item) => ({
      id: `momo:${item.code}`,
      source: 'momo',
      sku: item.code,
      name: item.name,
      price: item.price,
      currency: 'TWD',
      url: detailUrl(item.code),
      image: item.image || '',
      status: item.status || '',
      keywords: item.keywords,
    }));

  const dropped = all.length - products.length;
  if (dropped > 0) warnings.push(`有 ${dropped} 筆商品抓不到名稱，已略過。`);

  return { products, warnings };
}

module.exports = { scrape, parseSearchHtml, parseDetailHtml, detailUrl, SEARCH };
