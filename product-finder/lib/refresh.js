'use strict';

const momo = require('./momo');
const cyberbiz = require('./cyberbiz');
const store = require('./store');

const ADAPTERS = { momo: momo.scrape, alphaplus: cyberbiz.scrape };

/**
 * 同一時間只跑一個抓取工作。前端用 GET /api/job 輪詢進度。
 */
const job = {
  running: false,
  startedAt: null,
  finishedAt: null,
  sources: [],
  log: [],
  error: null,
};

function snapshot() {
  return { ...job, log: job.log.slice(-60) };
}

function note(message) {
  job.log.push({ at: new Date().toISOString(), message });
}

async function refresh(which = 'all') {
  if (job.running) throw new Error('已經有一個抓取工作在進行中。');

  const config = store.loadConfig();
  const wanted = which === 'all' ? Object.keys(config.sources) : [which];
  const targets = wanted.filter((key) => ADAPTERS[key] && config.sources[key]);
  if (!targets.length) throw new Error(`不認得的來源：${which}`);

  job.running = true;
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.sources = targets;
  job.log = [];
  job.error = null;

  const data = store.load();
  data.sources = data.sources || {};

  try {
    for (const key of targets) {
      const sourceConfig = config.sources[key];
      const label = sourceConfig.label || key;
      if (sourceConfig.enabled === false) {
        note(`${label}：已停用，略過。`);
        continue;
      }
      note(`${label}：開始抓取`);
      const startedAt = Date.now();
      try {
        const result = await ADAPTERS[key](sourceConfig, config.network, note);
        for (const warning of result.warnings || []) note(`${label}：${warning}`);

        // 一筆都沒抓到幾乎一定是連線被擋或網站改版，不是商品真的全下架。
        // 這種情況當成失敗處理：保留上一次的清單，不更新時間。
        if (result.products.length === 0) {
          throw new Error(
            (result.warnings && result.warnings[0]) || '沒有抓到任何商品（可能是連線被擋或網站改版）'
          );
        }

        data.sources[key] = {
          label,
          updatedAt: new Date().toISOString(),
          ok: true,
          error: null,
          seeded: false,
          strategy: result.strategy || null,
          warnings: result.warnings || [],
          products: result.products,
        };
        note(`${label}：完成，共 ${result.products.length} 筆（${Math.round((Date.now() - startedAt) / 1000)} 秒）`);
      } catch (err) {
        const previous = data.sources[key];
        data.sources[key] = {
          label,
          updatedAt: previous ? previous.updatedAt : null,
          ok: false,
          error: err.message,
          seeded: previous ? previous.seeded : false,
          warnings: previous ? previous.warnings || [] : [],
          // 抓取失敗時保留上一次的資料，總比清空讓同事查不到東西好
          products: previous ? previous.products || [] : [],
        };
        const kept = data.sources[key].products.length;
        note(`${label}：失敗 —— ${err.message}${kept ? `（保留上次的 ${kept} 筆）` : ''}`);
      }
    }
    store.save(data);
  } catch (err) {
    job.error = err.message;
    throw err;
  } finally {
    job.running = false;
    job.finishedAt = new Date().toISOString();
  }

  return data;
}

module.exports = { refresh, snapshot, job };
