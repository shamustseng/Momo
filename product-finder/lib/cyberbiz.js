'use strict';

const { fetchText, mapLimit, sleep } = require('./http');
const H = require('./html');

/**
 * Alpha Plus 官網（CYBERBIZ 平台）。
 * 官網沒有公開 API（/products.json 回 404），商品網址從兩個地方一起收，合併去重：
 *   1. sitemap.xml  —— SEO 用途，但實測會過期：新上架的商品可能好幾天都不在裡面
 *   2. 逐頁爬連結   —— 首頁與 /collections 分類頁（含分頁）上的 /products/ 連結，才是店面現在真的有的
 * 兩邊都要看，只信 sitemap 會漏掉新品。拿到網址後一律讀商品頁的 JSON-LD / og: 標籤取名稱與價格。
 */
async function scrape(sourceConfig, net, log = () => {}) {
  const origin = (sourceConfig.origin || 'https://alphaplus.cyberbiz.co').replace(/\/+$/, '');
  const locale = sourceConfig.locale || '';
  const maxProducts = Math.max(1, sourceConfig.maxProducts || 400);
  const warnings = [];

  const fromSitemap = await urlsFromSitemap(origin, net, log);
  const fromCrawl = await urlsFromCrawl(origin, locale, net, log);
  let urls = mergeProductUrls([...fromSitemap, ...fromCrawl], origin, locale);
  log(`官網：sitemap ${fromSitemap.length} 筆、店面頁面 ${fromCrawl.length} 筆，合併去重後 ${urls.length} 筆`);
  const strategy = fromSitemap.length && fromCrawl.length ? 'sitemap+crawl' : fromCrawl.length ? 'crawl' : 'sitemap';
  if (!urls.length) {
    warnings.push('sitemap 與店面頁面都沒抓到官網商品，請確認網址或網站是否改版。');
    return { products: [], warnings, strategy: 'none' };
  }

  urls = urls.slice(0, maxProducts);
  log(`官網：讀取 ${urls.length} 個商品頁`);
  const fetchProduct = async (url) => {
    const res = await fetchText(url, { timeoutMs: net.timeoutMs, retries: net.retries, referer: origin + '/' });
    if (!res.ok) return null;
    const item = parseProductHtml(res.body, res.url || url);
    return item.name ? item : null;
  };

  const byUrl = new Map();
  const first = await mapLimit(urls, net.concurrency, net.delayMs, fetchProduct);
  urls.forEach((url, i) => byUrl.set(url, first[i]));

  // 官網偶爾會有一兩頁暫時讀不到（連線抖動、被限流），隔一下再逐頁補抓一次，
  // 不要因為一次抖動就讓清單少一筆
  const missing = urls.filter((url) => !byUrl.get(url));
  if (missing.length) {
    log(`官網：${missing.length} 個商品頁第一次沒讀到，稍後補抓`);
    await sleep(Math.max(net.delayMs * 3, 1000));
    for (const url of missing) byUrl.set(url, await fetchProduct(url));
  }

  const products = [];
  const seen = new Set();
  const failed = [];
  for (const url of urls) {
    const item = byUrl.get(url);
    if (!item) { failed.push(url); continue; }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    products.push(item);
  }
  if (failed.length) {
    warnings.push(`有 ${failed.length} 個商品頁補抓後仍讀不到，已略過：${failed.map(slugOf).join('、')}`);
  }

  return { products, warnings, strategy };
}

function slugOf(url) {
  const raw = normalizeProductUrl(url).split('/products/')[1] || url;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

async function urlsFromSitemap(origin, net, log) {
  const queue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const visited = new Set();
  const productUrls = new Set();

  while (queue.length && visited.size < 25) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    log(`官網：讀取 sitemap ${url}`);
    const res = await fetchText(url, {
      timeoutMs: net.timeoutMs,
      retries: 1,
      accept: 'application/xml,text/xml,*/*',
    });
    if (!res.ok) continue;

    const locs = [...res.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => H.decode(m[1]));
    for (const loc of locs) {
      if (/\.xml(\.gz)?(\?|$)/i.test(loc)) {
        if (!visited.has(loc) && loc.startsWith(origin)) queue.push(loc);
      } else if (isProductUrl(loc, origin)) {
        productUrls.add(normalizeProductUrl(loc));
      }
    }
  }
  return [...productUrls];
}

/**
 * 從店面頁面收商品連結：首頁、「全部商品」分類頁，再加上首頁列出的各分類頁。
 * 分類頁有分頁（?page=N），一頁一頁翻到沒有新商品為止。
 */
async function urlsFromCrawl(origin, locale, net, log) {
  const prefix = locale ? `${origin}/${locale}` : origin;
  const seeds = [...new Set([`${origin}/`, `${prefix}/`, `${origin}/collections/all`, `${prefix}/collections/all`])];

  const productUrls = new Set();
  const categoryUrls = new Set();

  for (const seed of seeds) {
    log(`官網：爬取 ${seed}`);
    const res = await fetchText(seed, { timeoutMs: net.timeoutMs, retries: 1, referer: origin + '/' });
    if (!res.ok) continue;
    for (const link of extractLinks(res.body, origin)) {
      if (isProductUrl(link, origin)) productUrls.add(normalizeProductUrl(link));
      else if (/\/(categories|collections)\//i.test(link)) categoryUrls.add(link.split(/[?#]/)[0]);
    }
  }

  const categories = [...categoryUrls].slice(0, 30);
  const MAX_PAGES = 10;
  await mapLimit(categories, net.concurrency, net.delayMs, async (url) => {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetchText(`${url}?page=${page}`, { timeoutMs: net.timeoutMs, retries: 1, referer: origin + '/' });
      if (!res.ok) return;
      let fresh = 0;
      for (const link of extractLinks(res.body, origin)) {
        if (!isProductUrl(link, origin)) continue;
        const normalized = normalizeProductUrl(link);
        if (!productUrls.has(normalized)) fresh++;
        productUrls.add(normalized);
      }
      if (fresh === 0) return; // 這一頁沒有新商品，後面的分頁不用再翻
      if (net.delayMs > 0) await sleep(net.delayMs);
    }
  });

  return [...productUrls];
}

/**
 * 同一個商品在頁面上會以 /products/xxx 與 /zh-TW/products/xxx 兩種網址出現，
 * 而且中文 slug 有時已編碼、有時沒有；統一成一種寫法再去重，才不會同一頁讀兩次。
 */
function mergeProductUrls(urls, origin, locale) {
  const prefix = locale ? `${origin}/${locale}` : origin;
  const bySlug = new Map();
  for (const url of urls) {
    const slug = slugOf(url);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, `${prefix}/products/${encodeURIComponent(slug)}`);
  }
  return [...bySlug.values()];
}

function extractLinks(html, origin) {
  const links = new Set();
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = H.decode(m[1]);
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    try {
      links.add(new URL(href, origin + '/').toString());
    } catch {
      /* 略過壞掉的網址 */
    }
  }
  return [...links].filter((url) => url.startsWith(origin));
}

function isProductUrl(url, origin) {
  if (!url.startsWith(origin)) return false;
  const path = url.slice(origin.length).split(/[?#]/)[0];
  return /^(?:\/[a-z]{2}(?:-[A-Za-z]{2,4})?)?\/products\/[^/]+\/?$/.test(path);
}

function normalizeProductUrl(url) {
  return url.split(/[?#]/)[0].replace(/\/$/, '');
}

function parseProductHtml(html, url) {
  const nodes = H.jsonLd(html);
  const product = H.findType(nodes, 'product');

  let name = (product && H.decode(product.name)) || H.meta(html, 'og:title') || H.title(html);
  name = name.replace(/\s*[-|｜–]\s*(Alpha\s*Plus|阿爾法).*$/i, '').trim();

  const price =
    (product ? H.priceFromOffers(product.offers) : null) ??
    H.toPrice(H.meta(html, 'product:price:amount')) ??
    H.toPrice(H.meta(html, 'og:price:amount'));

  const availability = product ? H.availabilityFromOffers(product.offers) : '';
  const soldOut = /soldout|outofstock|discontinued/i.test(availability);
  // 滿額贈品在官網也是一個商品頁，但掛的是 99999 之類的佈告價，不是真的售價
  const giveaway = /^[（(]\s*贈品\s*[）)]/.test(name) || price >= 99999;

  const image =
    H.meta(html, 'og:image') ||
    (product && typeof product.image === 'string' ? product.image : '') ||
    (product && Array.isArray(product.image) ? product.image[0] : '') ||
    '';

  const slug = slugOf(url);
  const idMatch = slug.match(/^\d+/);

  return {
    id: `alphaplus:${slug}`,
    source: 'alphaplus',
    sku: idMatch ? idMatch[0] : '',
    name,
    price: giveaway ? null : price,
    currency: 'TWD',
    url: normalizeProductUrl(url),
    image: typeof image === 'string' ? image : '',
    status: giveaway ? '贈品（隨單附贈，不單獨販售）' : soldOut ? '售完或未開賣' : '',
    keywords: [],
  };
}

module.exports = { scrape, parseProductHtml, isProductUrl, extractLinks };
