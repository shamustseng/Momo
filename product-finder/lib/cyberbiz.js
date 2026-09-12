'use strict';

const { fetchText, mapLimit } = require('./http');
const H = require('./html');

/**
 * Alpha Plus 官網（CYBERBIZ 平台）。
 * 官網不保證有公開 API，所以依序試三種方式，哪個先成功就用哪個：
 *   1. /products.json  —— 部分店家會開放，最快也最完整
 *   2. sitemap.xml     —— SEO 用途，幾乎一定存在，能拿到全部商品網址
 *   3. 逐頁爬連結      —— 從首頁與分類頁撈 /products/ 連結
 * 拿到網址後一律讀商品頁的 JSON-LD / og: 標籤取名稱與價格。
 */
async function scrape(sourceConfig, net, log = () => {}) {
  const origin = (sourceConfig.origin || 'https://alphaplus.cyberbiz.co').replace(/\/+$/, '');
  const locale = sourceConfig.locale || '';
  const maxProducts = Math.max(1, sourceConfig.maxProducts || 400);
  const warnings = [];

  const viaJson = await tryProductsJson(origin, net, log);
  if (viaJson.products.length) {
    log(`官網：/products.json 取得 ${viaJson.products.length} 筆`);
    return { products: viaJson.products.slice(0, maxProducts), warnings, strategy: 'products.json' };
  }
  if (viaJson.warning) warnings.push(viaJson.warning);

  let urls = await urlsFromSitemap(origin, net, log);
  let strategy = 'sitemap';
  if (!urls.length) {
    warnings.push('sitemap.xml 沒有取得商品網址，改用逐頁爬連結。');
    urls = await urlsFromCrawl(origin, locale, net, log);
    strategy = 'crawl';
  }
  if (!urls.length) {
    warnings.push('三種方式都沒抓到官網商品，請確認網址或網站是否改版。');
    return { products: [], warnings, strategy: 'none' };
  }

  urls = urls.slice(0, maxProducts);
  log(`官網：讀取 ${urls.length} 個商品頁`);
  const results = await mapLimit(urls, net.concurrency, net.delayMs, async (url) => {
    const res = await fetchText(url, { timeoutMs: net.timeoutMs, retries: net.retries, referer: origin + '/' });
    if (!res.ok) return null;
    return parseProductHtml(res.body, res.url || url);
  });

  const products = [];
  const seen = new Set();
  for (const item of results) {
    if (!item || !item.name) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    products.push(item);
  }
  const failed = urls.length - products.length;
  if (failed > 0) warnings.push(`有 ${failed} 個商品頁讀取或解析失敗，已略過。`);

  return { products, warnings, strategy };
}

async function tryProductsJson(origin, net, log) {
  const products = [];
  for (let page = 1; page <= 10; page++) {
    const url = `${origin}/products.json?limit=250&page=${page}`;
    log(`官網：嘗試 ${url}`);
    const res = await fetchText(url, {
      timeoutMs: net.timeoutMs,
      retries: 0,
      accept: 'application/json,text/plain,*/*',
    });
    if (!res.ok) return { products, warning: page === 1 ? `/products.json 不可用（${res.error}）。` : null };
    let data;
    try {
      data = JSON.parse(res.body);
    } catch {
      return { products, warning: page === 1 ? '/products.json 回傳的不是 JSON。' : null };
    }
    const list = Array.isArray(data) ? data : data.products || data.data || [];
    if (!Array.isArray(list) || list.length === 0) break;
    for (const raw of list) products.push(fromJson(raw, origin));
    if (list.length < 250) break;
  }
  return { products: products.filter((p) => p && p.name), warning: null };
}

function fromJson(raw, origin) {
  if (!raw || typeof raw !== 'object') return null;
  const handle = raw.handle || raw.slug || raw.id;
  const variants = Array.isArray(raw.variants) ? raw.variants : [];
  const price =
    H.toPrice(raw.price) ??
    H.toPrice(raw.min_price) ??
    H.toPrice(variants.length ? variants[0].price : null);
  const images = Array.isArray(raw.images) ? raw.images : [];
  const image =
    (typeof raw.image === 'string' ? raw.image : raw.image && raw.image.src) ||
    (images.length ? images[0].src || images[0] : '') ||
    '';
  const available = variants.length
    ? variants.some((v) => v.available !== false && v.inventory_quantity !== 0)
    : raw.available !== false;
  return {
    id: `alphaplus:${raw.id || handle}`,
    source: 'alphaplus',
    sku: String(raw.id || handle || ''),
    name: H.decode(raw.title || raw.name || ''),
    price,
    currency: 'TWD',
    url: `${origin}/products/${handle}`,
    image: typeof image === 'string' ? image : '',
    status: available ? '' : '售完或未開賣',
    keywords: [],
  };
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

async function urlsFromCrawl(origin, locale, net, log) {
  const seeds = [
    `${origin}/`,
    locale ? `${origin}/${locale}` : null,
    `${origin}/categories`,
    `${origin}/products`,
  ].filter(Boolean);

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
  await mapLimit(categories, net.concurrency, net.delayMs, async (url) => {
    const res = await fetchText(url, { timeoutMs: net.timeoutMs, retries: 1, referer: origin + '/' });
    if (!res.ok) return;
    for (const link of extractLinks(res.body, origin)) {
      if (isProductUrl(link, origin)) productUrls.add(normalizeProductUrl(link));
    }
  });

  return [...productUrls];
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

  const image =
    H.meta(html, 'og:image') ||
    (product && typeof product.image === 'string' ? product.image : '') ||
    (product && Array.isArray(product.image) ? product.image[0] : '') ||
    '';

  const slug = normalizeProductUrl(url).split('/products/')[1] || url;
  const idMatch = slug.match(/^\d+/);

  return {
    id: `alphaplus:${idMatch ? idMatch[0] : slug}`,
    source: 'alphaplus',
    sku: idMatch ? idMatch[0] : slug,
    name,
    price,
    currency: 'TWD',
    url: normalizeProductUrl(url),
    image: typeof image === 'string' ? image : '',
    status: soldOut ? '售完或未開賣' : '',
    keywords: [],
  };
}

module.exports = { scrape, parseProductHtml, isProductUrl, extractLinks };
