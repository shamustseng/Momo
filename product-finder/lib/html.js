'use strict';

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', middot: '·', times: '×',
};

/** 還原 HTML 實體，並把連續空白壓成單一空格。 */
function decode(input) {
  if (!input) return '';
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function safeChar(code) {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** 去掉標籤，留下純文字。 */
function stripTags(html) {
  return decode(String(html || '').replace(/<[^>]*>/g, ' '));
}

/**
 * 取出 <meta> 內容。同時比對 property= 與 name=，且不假設屬性順序
 *（content 可能寫在 property 前面）。
 */
function meta(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  const keyRe = new RegExp(`(?:property|name|itemprop)\\s*=\\s*["']${escaped}["']`, 'i');
  for (const tag of tags) {
    if (!keyRe.test(tag)) continue;
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i);
    if (content && content[1].trim()) return decode(content[1]);
  }
  return '';
}

/** 解析頁面內所有 JSON-LD 區塊，回傳攤平後的物件陣列（含 @graph 內容）。 */
function jsonLd(html) {
  const out = [];
  const blocks =
    String(html || '').match(
      /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ) || [];
  for (const block of blocks) {
    const raw = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      try {
        parsed = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        continue;
      }
    }
    collect(parsed, out);
  }
  return out;
}

function collect(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out);
    return;
  }
  out.push(node);
  if (node['@graph']) collect(node['@graph'], out);
}

/** 從 JSON-LD 陣列中找出指定 @type 的第一筆。 */
function findType(nodes, type) {
  const wanted = String(type).toLowerCase();
  return (
    nodes.find((n) => {
      const t = n && n['@type'];
      if (!t) return false;
      return Array.isArray(t)
        ? t.some((x) => String(x).toLowerCase() === wanted)
        : String(t).toLowerCase() === wanted;
    }) || null
  );
}

function title(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decode(m[1]) : '';
}

/** 把 "NT$1,299 元" 之類的字串轉成數字；取不到回傳 null。 */
function toPrice(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const m = String(value).replace(/[,\s]/g, '').match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** 從 JSON-LD 的 offers 取價格（可能是物件、陣列或巢狀）。 */
function priceFromOffers(offers) {
  if (!offers) return null;
  const list = Array.isArray(offers) ? offers : [offers];
  for (const offer of list) {
    if (!offer || typeof offer !== 'object') continue;
    const price = toPrice(offer.price ?? offer.lowPrice ?? offer.highPrice);
    if (price !== null) return price;
    if (offer.priceSpecification) {
      const nested = priceFromOffers(offer.priceSpecification);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/** 從 JSON-LD 的 offers 判斷是否還買得到。 */
function availabilityFromOffers(offers) {
  if (!offers) return '';
  const list = Array.isArray(offers) ? offers : [offers];
  for (const offer of list) {
    if (offer && offer.availability) {
      return String(offer.availability).replace(/^https?:\/\/schema\.org\//i, '');
    }
  }
  return '';
}

module.exports = {
  decode, stripTags, meta, jsonLd, findType, title,
  toPrice, priceFromOffers, availabilityFromOffers,
};
