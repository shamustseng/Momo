'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE = path.join(DATA_DIR, 'cache.json');
const SEED = path.join(DATA_DIR, 'seed.json');
const CONFIG = path.join(__dirname, '..', 'config.json');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 讀快取；還沒抓過的話用內建初始清單，讓工具一打開就有東西可查。 */
function load() {
  return readJson(CACHE) || readJson(SEED) || { version: 1, sources: {} };
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(data, null, 2) + '\n');
  return data;
}

function loadConfig() {
  const config = readJson(CONFIG);
  if (!config) throw new Error(`讀不到設定檔：${CONFIG}`);
  config.network = {
    concurrency: 3, delayMs: 350, timeoutMs: 20000, retries: 2,
    ...(config.network || {}),
  };
  return config;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
  return config;
}

/** 把所有來源的商品攤平成一個陣列，供搜尋與匯出使用。 */
function allProducts(data) {
  const out = [];
  for (const [key, source] of Object.entries(data.sources || {})) {
    for (const product of source.products || []) out.push({ ...product, source: product.source || key });
  }
  return out;
}

module.exports = { load, save, loadConfig, saveConfig, allProducts, CACHE, SEED, CONFIG, DATA_DIR };
