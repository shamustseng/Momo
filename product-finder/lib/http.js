'use strict';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 取得網頁內容。失敗時重試（指數退避），逾時會中止連線。
 * 回傳 { ok, status, url, body }；非 2xx 或連線失敗時 ok=false 並帶 error。
 */
async function fetchText(url, opts = {}) {
  const {
    timeoutMs = 20000,
    retries = 2,
    headers = {},
    referer = null,
    accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  } = opts;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * Math.pow(2, attempt - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: accept,
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
          ...(referer ? { Referer: referer } : {}),
          ...headers,
        },
      });
      const body = await res.text();
      clearTimeout(timer);
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        // 4xx（除了 429）重試沒有意義，直接放棄
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          return { ok: false, status: res.status, url: res.url || url, body, error: lastError };
        }
        continue;
      }
      return { ok: true, status: res.status, url: res.url || url, body };
    } catch (err) {
      clearTimeout(timer);
      lastError = err.name === 'AbortError' ? `逾時（${timeoutMs}ms）` : err.message;
    }
  }
  return { ok: false, status: 0, url, body: '', error: lastError || '連線失敗' };
}

/** 以固定併發數逐一處理清單，每次呼叫之間留間隔，避免對來源站台造成負擔。 */
async function mapLimit(items, limit, delayMs, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      if (delayMs > 0) await sleep(delayMs);
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = { fetchText, mapLimit, sleep, UA };
