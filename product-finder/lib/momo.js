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
  const fromJsonLd = parseSearchJsonLd(html);
  if (fromJsonLd.length) return fromJsonLd;
  return parseSearchChunks(html);
}

/** 搜尋頁的 JSON-LD 內有完整的商品名稱、價格、圖片，一次拿齊，不用再開商品頁。 */
function parseSearchJsonLd(html) {
  const items = [];
  const seen = new Set();
  for (const node of H.jsonLd(html)) {
    const products = node['@type'] === 'ItemList' && Array.isArray(node.itemListElement)
      ? node.itemListElement.map((e) => (e && e.item) || e)
      : [node];
    for (const prod of products) {
      if (!prod || typeof prod !== 'object') continue;
      const type = Array.isArray(prod['@type']) ? prod['@type'].join(',') : String(prod['@type'] || '');
      if (!/product/i.test(type)) continue;
      const m = String(prod.url || '').match(/i_code=(\d{4,})/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      items.push({
        code: m[1],
        name: H.decode(prod.name || ''),
        price: H.priceFromOffers(prod.offers),
        image: firstImage(prod.image),
        availability: H.availabilityFromOffers(prod.offers),
      });
    }
  }
  return items;
}

function parseSearchChunks(html) {
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

/**
 * 從商品頁取名稱、價格與圖片。
 * momo 商品頁的頭條價格不一定是「促銷價」：有限時活動時頭條會變成「限時折後價」，
 * 促銷價被畫掉排在下面，而 meta 標籤、JSON-LD 與搜尋結果頁給的都是頭條那個數字。
 * 我們要的是促銷價，所以另外從頁面把「促銷價」那一欄挑出來（promoPrice）。
 */
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

  return { name, price, promoPrice: promoPriceFromDetail(html), image };
}

/**
 * 商品頁裡「促銷價」的數字。兩種寫法都認：
 *  - 頁面資料（RSC payload，引號會被跳脫）：\"formName\":\"促銷價\",...\"formContent\":\"1,087元\"
 *    或 \"priceName\":\"促銷價\",\"priceValue\":\"330\"
 *  - 畫面 HTML：<span>促銷價</span><span class="font-price ..."><div><span class="hidden">$</span><span>330</span>
 */
function promoPriceFromDetail(html) {
  const patterns = [
    /\\?"(?:formName|priceName)\\?"\s*:\s*\\?"促銷價\\?"[^{}[\]]{0,80}?\\?"(?:formContent|priceValue)\\?"\s*:\s*\\?"([\d,]+)/,
    /促銷價<\/span>\s*<span[^>]*font-price[^>]*>(?:\s*<div[^>]*>)?(?:\s*<span[^>]*>\$<\/span>)?\s*<span[^>]*>([\d,]+)<\/span>/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const price = H.toPrice(m[1]);
      if (price !== null && price > 0) return price;
    }
  }
  return null;
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
    let seen = 0;
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
      seen += items.length;

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
    log(`momo：「${keyword}」搜到 ${seen} 筆，其中 ${found} 筆是新商品`);
    if (seen === 0) warnings.push(`「${keyword}」沒有搜到任何商品，請確認關鍵字或 momo 是否改版。`);
  }

  // momo 的關鍵字搜尋是模糊比對（「雞湯桑」會撈到別家的「桑拿雞蒸鍋」），
  // 所以只留名稱裡真的有我們品牌字樣的商品
  const mustMatch = (sourceConfig.mustMatch || []).map((t) => String(t).toLowerCase()).filter(Boolean);
  const isOurs = (name) => !mustMatch.length || mustMatch.some((t) => name.toLowerCase().includes(t));

  // 每一筆都開商品頁：搜尋結果頁給的是頭條價（有限時活動時是「限時折後價」），
  // 我們要的是「促銷價」，只有商品頁才分得出來。還沒有名稱的也一起抓，抓完再判斷是不是本集團商品。
  const all = [...byCode.values()];
  const candidates = all.filter((item) => !item.name || isOurs(item.name));
  let detailFailed = 0;
  if (candidates.length) {
    log(`momo：讀取 ${candidates.length} 筆商品頁，取「促銷價」`);
    await mapLimit(candidates, net.concurrency, net.delayMs, async (item) => {
      const res = await fetchText(detailUrl(item.code), {
        timeoutMs: net.timeoutMs,
        retries: net.retries,
        referer: `${ORIGIN}/`,
      });
      if (!res.ok) {
        if (!item.name) item.status = res.status === 404 ? '已下架或不存在' : `明細讀取失敗（${res.error}）`;
        else detailFailed++;
        return;
      }
      const detail = parseDetailHtml(res.body);
      if (!item.name && detail.name) item.name = detail.name;
      if (detail.promoPrice !== null) item.price = detail.promoPrice;
      else if (item.price === null && detail.price !== null) item.price = detail.price;
      if (!item.image && detail.image) item.image = detail.image;
    });
  }
  if (detailFailed > 0) warnings.push(`有 ${detailFailed} 筆商品頁讀不到，價格沿用搜尋結果頁顯示價（可能是限時折後價）。`);

  const offBrand = all.filter((item) => item.name && !isOurs(item.name));
  if (offBrand.length) {
    log(`momo：略過 ${offBrand.length} 筆非本集團商品（${offBrand.slice(0, 2).map((i) => i.name.slice(0, 18)).join('、')}…）`);
  }

  const products = all
    .filter((item) => item.name && isOurs(item.name))
    .map((item) => ({
      id: `momo:${item.code}`,
      source: 'momo',
      sku: item.code,
      name: item.name,
      price: item.price,
      currency: 'TWD',
      url: detailUrl(item.code),
      image: item.image || '',
      status: item.status || (/soldout|outofstock|discontinued/i.test(item.availability || '') ? '售完或未開賣' : ''),
      keywords: item.keywords,
    }));

  const nameless = all.filter((item) => !item.name).length;
  if (nameless > 0) warnings.push(`有 ${nameless} 筆商品抓不到名稱，已略過。`);

  return { products, warnings };
}

module.exports = { scrape, parseSearchHtml, parseDetailHtml, promoPriceFromDetail, detailUrl, SEARCH };
