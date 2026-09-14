'use strict';

const LABEL = { momo: 'momo 購物網', alphaplus: 'Alpha Plus 官網' };

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 匯出 CSV。加 BOM，Excel 開啟中文才不會變亂碼。 */
function toCsv(products, { bom = true } = {}) {
  // 「momo 品號」是 momo 官網商品頁上寫的「品號」（即 i_code），Alpha Plus 官網沒有對應編號，該欄留空
  const header = ['來源', '商品名稱', '售價(TWD)', '商品連結', 'momo 品號', '狀態', '對應關鍵字'];
  const lines = [header.map(csvCell).join(',')];
  for (const p of products) {
    lines.push([
      LABEL[p.source] || p.source,
      p.name,
      p.price === null || p.price === undefined ? '' : p.price,
      p.url,
      p.source === 'momo' ? (p.sku || '') : '',
      p.status || '上架中',
      (p.keywords || []).join(' / '),
    ].map(csvCell).join(','));
  }
  return (bom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}

/** 匯出 Markdown，方便直接貼進聊天室或簡報。 */
function toMarkdown(products, updatedAt = {}) {
  const groups = new Map();
  for (const p of products) {
    if (!groups.has(p.source)) groups.set(p.source, []);
    groups.get(p.source).push(p);
  }
  const out = ['# 阿爾法餐飲 產品與連結清單', ''];
  for (const [source, list] of groups) {
    out.push(`## ${LABEL[source] || source}（${list.length} 筆）`);
    const stamp = updatedAt[source];
    if (stamp) out.push(`更新時間：${new Date(stamp).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' })}`);
    out.push('');
    for (const p of list) {
      const price = p.price === null || p.price === undefined ? '價格未取得' : `$${p.price.toLocaleString('zh-TW')}`;
      const status = p.status ? `｜${p.status}` : '';
      const sku = p.source === 'momo' && p.sku ? `｜momo 品號 ${p.sku}` : '';
      out.push(`- ${p.name}｜${price}${sku}${status}｜${p.url}`);
    }
    out.push('');
  }
  return out.join('\n');
}

module.exports = { toCsv, toMarkdown, LABEL };
